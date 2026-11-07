/** three r185 point-light attenuation, in radiance per candela. */
export function pointIrradiance(intensity, distanceSquared, range = 0, decay = 2) {
  const attenuation = 1 / Math.max(Math.pow(Math.max(0, distanceSquared), decay / 2), 0.01);
  const window = range > 0 ? Math.max(0, 1 - Math.pow(distanceSquared / (range * range), 2)) : 1;
  return Math.max(0, intensity) * attenuation * window * window;
}
