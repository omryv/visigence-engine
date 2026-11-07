// Image-based lighting from the world's OWN sky. The procedural dome is
// captured into a PMREM environment map and set as scene.environment, so
// every standard material — wet stone, metal roofs, window glass, a rifle —
// picks up real ambient and specular light that tracks time of day, biome
// palette, haze and weather. This is what makes a dusk world glow amber on
// every surface instead of only in the sky, and it costs a few milliseconds
// only when the light actually changes (the engine debounces refresh()).
//
// The capture shares the live Sky material, so there is exactly one
// definition of what the sky looks like. The node renderer tone maps only on
// the way to the canvas, so the dome reaches the PMREM as linear radiance.

import * as THREE from "three";

export class SkyEnvironment {
  constructor(renderer, atmos) {
    this.renderer = renderer;
    this.atmos = atmos;
    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._scene = new THREE.Scene();
    this._proxy = null;
    this._rt = null;
  }

  /* Capture the sky rig's dome into scene.environment. Call through the
     engine's debounce — a PMREM per slider tick would be waste.

     `size` is the cube edge the capture is taken at, and it is the one lever
     that actually exists here. PMREMGenerator.fromScene allocates a fresh
     mip-chained target on every call and there is no way to hand it one to
     reuse: only fromEquirectangular and fromCubemap take a renderTarget, and
     fromScene's fifth argument is an options object carrying `size` and
     `position`, nothing else. So the allocation cannot be avoided — but it
     can be made small. At 256 the target is 3·256 × 4·256 half-float, which
     is 6.3 MB allocated and freed per capture; at 128 it is 1.6 MB. Dragging
     the time of day fires this four times a second, so the engine captures
     at 128 while the light is moving and once at full size when it settles.
     A dome is a smooth gradient and this is being convolved into irradiance
     regardless: the interim captures do not need the resolution, and the one
     that stays on screen still gets it. */
  update(scene, sky, { size = 256 } = {}) {
    if (!this._proxy) {
      this._proxy = new THREE.Mesh(sky.mesh.geometry, sky.mesh.material);
      this._proxy.scale.copy(sky.mesh.scale);
      this._proxy.frustumCulled = false;
      this._scene.add(this._proxy);
    }
    // The dome is a node material the renderer tone maps only on the way to
    // the canvas, so what reaches the PMREM is linear radiance already.
    const rt = this._pmrem.fromScene(this._scene, 0, 1, 10, { size });
    if (!rt) return;
    this.size = size;
    const old = this._rt;
    this._rt = rt;
    scene.environment = rt.texture;
    // The dome is already the whole ambient story; at full strength the IBL
    // would double-count against the hemisphere light the rig keeps for
    // shadowed diffuse. The engine halves that light when IBL is on.
    scene.environmentIntensity = 0.5;
    old?.dispose();
  }

  dispose() {
    this._rt?.dispose();
    this._rt = null;
    if (this._proxy) { this._scene.remove(this._proxy); this._proxy = null; } // geometry/material belong to Sky
    this._pmrem.dispose();
  }
}
