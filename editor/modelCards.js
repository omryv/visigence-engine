/**
 * Catalog cards drawn from the model when the card image is missing.
 *
 * A card <img> that names its model (`data-card-model`) and fails to load is replaced by a
 * render of that GLB: a three-quarter view on the studio's dark-slate ground, the same
 * framing the Blender thumbnails use. Cards whose PNG loads never touch this module, so it
 * costs nothing until an image is missing. One offscreen renderer draws every card, one at a
 * time, and each model's card is cached for the session.
 */
import { assetURL } from '../src/config/assetDelivery.js';

const SIZE = 256, cards = new Map();
let stage = null, queue = Promise.resolve();

async function createStage() {
  const THREE = await import('three/webgpu');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true, alpha: false });
  await renderer.init();
  renderer.setPixelRatio(1); renderer.setSize(SIZE, SIZE, false);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#1c2830');
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x5a6a60, 2.2));
  for (const [position, color, intensity] of [[[4, 7, 5], 0xfff0d8, 3.2], [[-5, 3, -3], 0xbfdcff, 1.4]]) {
    const light = new THREE.DirectionalLight(color, intensity); light.position.set(...position); scene.add(light);
  }
  return { THREE, renderer, scene, camera: new THREE.PerspectiveCamera(30, 1, 0.01, 500), loader: new GLTFLoader() };
}

async function draw(model) {
  stage ??= createStage();
  const { THREE, renderer, scene, camera, loader } = await stage;
  const root = (await loader.loadAsync(assetURL(model))).scene;
  const bounds = new THREE.Box3().setFromObject(root), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
  root.position.set(-center.x, -bounds.min.y, -center.z); scene.add(root);
  const radius = Math.max(size.length() / 2, 0.01), distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
  const target = new THREE.Vector3(0, size.y / 2, 0);
  camera.position.copy(target).add(new THREE.Vector3(0.62, 0.42, 0.66).normalize().multiplyScalar(distance));
  camera.near = distance / 100; camera.far = distance * 4; camera.updateProjectionMatrix(); camera.lookAt(target);
  try {
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  } finally {
    scene.remove(root);
    root.traverse(o => { if (!o.isMesh) return; o.geometry.dispose(); for (const m of [o.material].flat()) { for (const v of Object.values(m)) if (v?.isTexture) v.dispose(); m.dispose(); } });
  }
}

/** The card for a model, rendered once per session. */
export function modelCard(model) {
  if (!cards.has(model)) {
    const card = queue.then(() => draw(model));
    queue = card.catch(() => {});
    cards.set(model, card);
    card.catch(() => cards.delete(model));
  }
  return cards.get(model);
}

/** Replace any card image that fails to load with a render of its `data-card-model`. */
export function installModelCards(root = document) {
  root.addEventListener('error', event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.cardModel || img.dataset.cardRendered) return;
    img.dataset.cardRendered = 'pending';
    modelCard(img.dataset.cardModel).then(url => { img.dataset.cardRendered = 'done'; img.src = url; }, () => {});
  }, true);
}
