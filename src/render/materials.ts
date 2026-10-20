// Custom shaders. All of them do their own distance fog so they blend into the horizon glow.
import * as THREE from 'three';
import { BEND_GLSL, bendUniform } from './curve.ts';

export const fogUniforms = {
  uFog: { value: new THREE.Color() },
  uFogNear: { value: 40 },
  uFogFar: { value: 200 },
};

const FOG_VARYINGS = /* glsl */ `
  varying vec3 vWorld;
  varying float vDepth;
`;
/** Vertex-side prelude: varyings plus the curved-world helper. */
const FOG_VERT = FOG_VARYINGS + BEND_GLSL;

export function floorMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...fogUniforms,
      uOffset: { value: 0 },
      uPulse: { value: 0 },
      uWave: { value: 0 },
      uGrid: { value: new THREE.Color() },
      uTrack: { value: new THREE.Color() },
      uTrackHalf: { value: 6 },
      uLaneW: { value: 2.4 },
      uBend: bendUniform,
    },
    vertexShader: /* glsl */ `
      ${FOG_VERT}
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        w.xyz += bendOffset(w.xyz);
        vec4 mv = viewMatrix * w;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${FOG_VARYINGS}
      uniform vec3 uFog; uniform float uFogNear; uniform float uFogFar;
      uniform float uOffset; uniform float uPulse; uniform float uWave;
      uniform vec3 uGrid; uniform vec3 uTrack; uniform float uTrackHalf; uniform float uLaneW;

      float line(float v, float cell, float width) {
        float g = abs(fract(v / cell + 0.5) - 0.5) * cell;
        return 1.0 - smoothstep(0.0, fwidth(v) * width, g);
      }

      void main() {
        float z = vWorld.z - uOffset;
        float ax = abs(vWorld.x);
        float inTrack = 1.0 - smoothstep(uTrackHalf, uTrackHalf + 0.05, ax);
        float far = smoothstep(50.0, 210.0, vDepth);

        // Lane dividers and cross lines on the track; a wider, dimmer grid beyond it.
        float lanes = line(vWorld.x + uTrackHalf, uLaneW, 1.6);
        float cross = line(z, 3.0, 1.3);
        float outer = max(line(vWorld.x + uTrackHalf, uLaneW * 2.0, 1.2), line(z, 6.0, 1.2) * (1.0 - smoothstep(25.0, 110.0, vDepth)));
        // Cross lines get denser than a pixel far away and smear into a bright haze, so fade them early.
        float crossFade = 1.0 - smoothstep(20.0, 85.0, vDepth);
        float trackLines = max(lanes * (1.0 - smoothstep(70.0, 190.0, vDepth)), cross * 0.55 * crossFade);

        // A bright band that rolls in from the horizon on every beat.
        float band = exp(-pow((vDepth - uWave) / 7.0, 2.0)) * (1.0 - smoothstep(60.0, 160.0, vDepth));

        float glow = 1.0 + uPulse * 0.8 + band * 1.6;
        vec3 base = mix(vec3(0.004, 0.0, 0.012), uFog * 0.18, far);
        vec3 col = base;
        col += uTrack * trackLines * inTrack * 1.6 * glow * (1.0 - far * 0.7);
        col += uGrid * outer * (1.0 - inTrack) * 0.55 * glow * (1.0 - far * 0.8) * (1.0 - smoothstep(30.0, 140.0, ax));
        col += uTrack * inTrack * 0.025;

        float fog = smoothstep(uFogNear, uFogFar, vDepth);
        gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
      }
    `,
  });
}

export function skyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uPulse: { value: 0 } },
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 uTop; uniform vec3 uHorizon; uniform float uPulse;
      void main() {
        float h = vDir.y;
        vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.42, h));
        col += uHorizon * (0.9 + uPulse * 0.25) * exp(-abs(h) * 16.0);
        col = mix(col, uHorizon * 0.12, smoothstep(0.0, -0.12, h));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export function sunMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTop: { value: new THREE.Color() }, uBottom: { value: new THREE.Color() }, uTime: { value: 0 }, uPulse: { value: 0 } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform vec3 uTop; uniform vec3 uBottom; uniform float uTime; uniform float uPulse;
      void main() {
        vec2 c = vUv - 0.5;
        float r = length(c);
        float disc = 1.0 - smoothstep(0.295, 0.3, r);
        vec3 col = mix(uBottom, uTop, smoothstep(-0.28, 0.3, c.y));
        // Retro stripes cut into the lower half, widening toward the bottom and drifting down.
        float zone = smoothstep(0.06, -0.04, c.y);
        float s = fract((c.y + uTime * 0.015) * 28.0);
        float gapW = clamp(-c.y / 0.3, 0.0, 1.0) * 0.55;
        float cut = step(s, gapW) * zone;
        float body = disc * (1.0 - cut);
        float halo = exp(-max(r - 0.27, 0.0) * 13.0) * (0.35 + uPulse * 0.15);
        // Kept below the bloom threshold in the middle so the gradient and stripes survive.
        vec3 outCol = col * body * 0.8 + uBottom * halo * (1.0 - body) * 0.6;
        gl_FragColor = vec4(outCol, max(body, halo * 0.85));
      }
    `,
  });
}

/** Hologram material for obstacles: dark translucent body, glowing frame, moving scanlines, fresnel rim. */
export function holoMaterial(color: THREE.Color) {
  return new THREE.ShaderMaterial({
    uniforms: { ...fogUniforms, uColor: { value: color }, uTime: { value: 0 }, uPulse: { value: 0 }, uBend: bendUniform },
    transparent: true,
    vertexShader: /* glsl */ `
      ${FOG_VERT}
      varying vec2 vUv;
      varying vec3 vNormalW;
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        w.xyz += bendOffset(w.xyz);
        vec4 mv = viewMatrix * w;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${FOG_VARYINGS}
      varying vec2 vUv;
      varying vec3 vNormalW;
      uniform vec3 uFog; uniform float uFogNear; uniform float uFogFar;
      uniform vec3 uColor; uniform float uTime; uniform float uPulse;
      void main() {
        vec2 e2 = min(vUv, 1.0 - vUv);
        float e = min(e2.x, e2.y);
        float edge = 1.0 - smoothstep(0.0, 0.045, e);
        float scan = 0.5 + 0.5 * sin(vWorld.y * 16.0 - uTime * 6.0);
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - abs(dot(normalize(vNormalW), viewDir)), 2.0);
        vec3 col = uColor * (0.1 + 0.08 * scan + fres * 0.55 + uPulse * 0.1) + uColor * edge * (2.2 + uPulse);
        float fog = smoothstep(uFogNear, uFogFar, vDepth);
        gl_FragColor = vec4(mix(col, uFog, fog), mix(0.9, 1.0, fog));
      }
    `,
  });
}

/** Moving light dashes along the track-edge rails. */
export function railMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...fogUniforms, uColor: { value: new THREE.Color() }, uOffset: { value: 0 }, uBend: bendUniform },
    vertexShader: /* glsl */ `
      ${FOG_VERT}
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        w.xyz += bendOffset(w.xyz);
        vec4 mv = viewMatrix * w;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${FOG_VARYINGS}
      uniform vec3 uFog; uniform float uFogNear; uniform float uFogFar;
      uniform vec3 uColor; uniform float uOffset;
      void main() {
        float d = fract((vWorld.z - uOffset * 1.0) / 12.0);
        float dash = smoothstep(0.0, 0.08, d) * (1.0 - smoothstep(0.5, 0.6, d));
        // Fade right next to the camera, where a rail would otherwise bloom across the screen.
        vec3 col = uColor * (0.6 + dash * 2.4) * smoothstep(1.5, 9.0, vDepth);
        float fog = smoothstep(uFogNear, uFogFar, vDepth);
        gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
      }
    `,
  });
}

/** Additive camera-facing points with per-particle colour, size and alpha. */
export function particleMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 1 }, uBend: bendUniform },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      ${BEND_GLSL}
      attribute float aSize;
      attribute float aAlpha;
      attribute vec3 aColor;
      varying vec3 vColor;
      varying float vAlpha;
      uniform float uScale;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        w.xyz += bendOffset(w.xyz);
        vec4 mv = viewMatrix * w;
        // Capped so sparks right in front of the camera don't balloon into screen-filling blobs.
        gl_PointSize = min(aSize * uScale * (300.0 / max(0.1, -mv.z)), 48.0 * uScale);
        gl_Position = projectionMatrix * mv;
        vColor = aColor;
        vAlpha = aAlpha;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor * a * a * vAlpha * 1.6, 1.0);
      }
    `,
  });
}

/** Ribbon trail: per-vertex alpha and tint, additive. */
export function trailMaterial(color: THREE.Color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color }, uBend: bendUniform },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      ${BEND_GLSL}
      attribute float aAlpha;
      attribute vec3 aColor;
      varying float vAlpha;
      varying vec3 vTint;
      void main() {
        vAlpha = aAlpha;
        vTint = aColor;
        vec4 w = modelMatrix * vec4(position, 1.0);
        w.xyz += bendOffset(w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying vec3 vTint;
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor * vTint * vAlpha * 2.2, 1.0); }
    `,
  });
}

/** Full-screen finishing pass: chromatic aberration, vignette, scanlines, grain and flash. */
export const FinishShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0.002 },
    uVignette: { value: 0.85 },
    uScan: { value: 0.035 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime; uniform float uAberration; uniform float uVignette; uniform float uScan; uniform float uFlash;
    uniform vec3 uFlashColor;
    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c);
      vec2 off = c * uAberration * (1.0 + r * 2.0);
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      col *= 1.0 - uScan * (0.5 + 0.5 * sin(vUv.y * 1100.0));
      col *= mix(1.0, smoothstep(0.92, 0.28, r), uVignette);
      float n = fract(sin(dot(vUv * 731.7 + uTime * 61.3, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      col += n * 0.022;
      col = mix(col, uFlashColor, clamp(uFlash, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
