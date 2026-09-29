import {
  BackSide,
  Color,
  GridHelper,
  HemisphereLight,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  type World,
} from '@iwsdk/core';

/** A dark gradient dome and a floor grid, so panels have a sense of place. */
export function buildEnvironment(world: World): void {
  const dome = new Mesh(
    new SphereGeometry(80, 48, 24),
    new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new Color('#1a1c2e') },
        horizon: { value: new Color('#0b0c14') },
        bottom: { value: new Color('#040408') },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top, horizon, bottom;
        varying vec3 vDir;
        void main() {
          float h = vDir.y;
          vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.6)) : mix(horizon, bottom, pow(-h, 0.4));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  dome.renderOrder = -1;
  world.scene.add(dome);

  const grid = new GridHelper(40, 80, 0x3a3f5c, 0x1a1d2b);
  world.scene.add(grid);

  world.scene.add(new HemisphereLight(0xcdd6f4, 0x0b0c14, 1.2));
}
