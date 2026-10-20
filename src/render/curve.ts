// "Curved world": everything ahead of the player is pushed sideways and up/down by an amount that
// grows with the square of its distance, so the straight track appears to sweep and roll over hills.
// It's purely visual: the simulation (and every collision) stays on a straight line.
import * as THREE from 'three';

/** x: lateral bend, y: vertical bend (per metre²). Shared by every bent material. */
export const bendUniform = { value: new THREE.Vector2(0, 0) };

/** Beyond this distance the offset stops growing, so far scenery shifts but doesn't swing wildly. */
const MAX_BEND_DIST = 210;

export const BEND_GLSL = /* glsl */ `
  uniform vec2 uBend;
  vec3 bendOffset(vec3 w) {
    float d = clamp(-w.z, 0.0, ${MAX_BEND_DIST.toFixed(1)});
    float d2 = d * d;
    return vec3(uBend.x * d2, uBend.y * d2, 0.0);
  }
`;

const PROJECT = /* glsl */ `
  vec4 bentWorld = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    bentWorld = instanceMatrix * bentWorld;
  #endif
  bentWorld = modelMatrix * bentWorld;
  bentWorld.xyz += bendOffset( bentWorld.xyz );
  vec4 mvPosition = viewMatrix * bentWorld;
  gl_Position = projectionMatrix * mvPosition;
`;

/** Patches a built-in material (MeshBasic, LineBasic, Points…) to follow the curve. */
export function bend<T extends THREE.Material>(m: T): T {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBend = bendUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${BEND_GLSL}`)
      .replace('#include <project_vertex>', PROJECT);
  };
  m.customProgramCacheKey = () => 'bend';
  return m;
}

/** World-space bend offset for a point (for placing HTML over bent objects). */
export function bendOffset(v: THREE.Vector3, out = new THREE.Vector3()) {
  const d = Math.min(Math.max(-v.z, 0), MAX_BEND_DIST);
  return out.set(bendUniform.value.x * d * d, bendUniform.value.y * d * d, 0);
}

/**
 * The road's shape as a function of distance travelled: gentle sweeps and hills that blend
 * between overlapping sine waves, starting dead straight and growing with speed.
 */
export function curveAt(distance: number, intensity: number): THREE.Vector2 {
  const ramp = Math.min(1, Math.max(0, (distance - 250) / 600)) * intensity;
  const x = (Math.sin(distance / 820) * 0.7 + Math.sin(distance / 330 + 1.7) * 0.3) * 0.00125;
  const y = (Math.sin(distance / 540 + 0.6) * 0.6 + Math.sin(distance / 260 + 2.4) * 0.4) * 0.00058;
  return new THREE.Vector2(x * ramp, y * ramp);
}
