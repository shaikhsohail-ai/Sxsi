/**
 * Join backdrop — one full-screen fragment shader, no textures, no three.js:
 * deep space, a vast planetary limb and an orbital sunrise cresting dead
 * centre. `rise` (0 → 1, scrubbed by scroll) lifts the limb into frame and
 * brings the sun over it.
 */
import { byTier, dpr } from '../../lib/quality.js'

const VERT = /* glsl */ `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const FRAG = /* glsl */ `
precision highp float;

uniform vec2 uRes;     // drawing-buffer size, px
uniform float uScale;  // drawing-buffer px per CSS px
uniform float uTime;
uniform float uRise;   // 0: limb below frame · 1: sun crested

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

// Jittered-grid star layer; px and cell are in CSS pixels so stars stay crisp.
float stars(vec2 px, float cell, float density, float t) {
  vec2 g = px / cell;
  vec2 id = floor(g);
  float h = hash12(id);
  if (h > density) return 0.0;
  vec2 pos = 0.15 + 0.7 * hash22(id + 7.31);
  float d = length((fract(g) - pos) * cell);
  float size = mix(0.45, 1.25, pow(hash12(id + 3.7), 4.0));
  float twinkle = 0.7 + 0.3 * sin(t * (0.5 + 1.8 * hash12(id + 1.3)) + h * 50.0);
  float mag = mix(0.18, 1.0, pow(hash12(id + 9.1), 3.0));
  return smoothstep(size + 0.75, size * 0.25, d) * twinkle * mag;
}

// Above the limb: a razor-thin bright edge, blue haze, then a wide faint
// glow that fades to black space, with stars showing through.
vec3 skySide(float h, vec2 px, float near, float nearWide, float nearTight, float light) {
  float edge = exp(-h / 0.0035);
  float band = exp(-h / 0.011);
  float haze = exp(-h / 0.045);
  float wide = exp(-h / 0.2);

  vec3 cEdge = mix(vec3(0.55, 0.86, 1.0), vec3(1.0, 0.86, 0.68), nearTight);
  vec3 cBand = mix(vec3(0.16, 0.5, 1.0), vec3(1.0, 0.56, 0.24), nearTight * 0.85);
  vec3 cHaze = mix(vec3(0.07, 0.3, 0.95), vec3(0.3, 0.62, 1.0), near);

  vec3 col = cEdge * edge * (0.5 + 2.4 * near) * light;
  col += cBand * band * (0.22 + 1.3 * near) * light;
  col += cHaze * haze * (0.16 + 0.7 * nearWide) * light;
  col += vec3(0.04, 0.16, 0.55) * wide * (0.12 + 0.3 * nearWide) * light;

  float sky = clamp((haze * 1.2 + wide * 0.6) * light, 0.0, 1.0);
  float st = stars(px, 54.0, 0.26, uTime) + 0.65 * stars(px + 31.0, 26.0, 0.1, uTime * 1.4);
  return col + vec3(0.9, 0.95, 1.0) * st * (1.0 - sky) * 0.85;
}

// Night side: near-black, scattered light along the rim, a warm terminator
// (sunlit cloud tops) under the sun, and city lights — a network of light.
vec3 nightSide(float depth, float arc, float R, float near, float nearTight, float light, float sunUp, float lift) {
  float rim = exp(-depth / 0.016);
  vec3 surf = vec3(0.002, 0.004, 0.01);
  surf += vec3(0.05, 0.16, 0.45) * rim * (0.25 + 0.9 * near) * light;

  // Foreshortened cloud texture near the limb
  vec2 cp = vec2(arc * 7.0, pow(depth, 0.6) * 26.0);
  float clouds = noise(cp) * 0.6 + noise(cp * 2.3 + 4.1) * 0.4;
  clouds = smoothstep(0.42, 0.85, clouds);
  float lit = exp(-depth / 0.05) * near;
  surf += vec3(0.25, 0.5, 0.95) * clouds * lit * 0.18 * light;
  surf += vec3(1.0, 0.55, 0.25) * exp(-depth / 0.01) * nearTight * 0.9 * sunUp;
  surf += vec3(1.0, 0.6, 0.3) * clouds * exp(-depth / 0.03) * nearTight * 0.25 * sunUp;

  // City lights. Surface coords are (distance along the limb, ground distance
  // from the limb); ground distance grows with sqrt(depth), so the field
  // foreshortens towards the horizon on its own. Tight metro clusters with a
  // glow of their own, a sparse rural scatter between them.
  float g = sqrt(2.0 * R * depth);
  vec2 sc = vec2(arc, g);
  float land = noise(sc * 3.2 + 11.0) * 0.6 + noise(sc * 8.5 - 3.0) * 0.4;
  float metro = smoothstep(0.58, 0.86, land);
  // fade near the limb (extinction; cells go sub-pixel) and in the sun's glare
  float seen = smoothstep(0.012, 0.08, depth) * (1.0 - 0.9 * near) * mix(0.3, 1.0, lift);
  vec2 cell = sc * 78.0;
  vec2 cid = floor(cell);
  if (seen > 0.0 && hash12(cid + 17.0) < metro * 0.92 + 0.035) {
    vec2 off = (fract(cell) - (0.2 + 0.6 * hash22(cid + 4.2))) / 78.0;
    // back to screen space: ground distance compresses by g / R
    vec2 offPx = vec2(off.x, off.y * g / R) * uRes.y / uScale;
    float bright = mix(0.18, 1.0, pow(hash12(cid + 2.9), 2.5)) * (0.35 + 0.9 * metro);
    vec3 tint = mix(vec3(1.0, 0.7, 0.4), vec3(0.72, 0.87, 1.0), step(0.8, hash12(cid + 8.1)));
    surf += tint * exp(-dot(offPx, offPx) / 0.6) * bright * 0.8 * seen;
  }
  // sodium glow over the metro cores
  surf += vec3(1.0, 0.62, 0.32) * metro * metro * 0.035 * seen;
  return surf;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float aspect = uRes.x / uRes.y;
  vec2 p = (frag - 0.5 * uRes) / uRes.y;   // y up, frame height = 1
  vec2 px = frag / uScale;

  // rise follows the finale scrolling in: the limb waits below the frame,
  // then lifts with the type so the two never cross; the sun crests last.
  float rise = clamp(uRise, 0.0, 1.0);
  float lift = smoothstep(0.28, 1.0, rise);
  float sunUp = smoothstep(0.5, 1.0, rise);

  // Planet: radius follows the frame width so the curvature reads the same on
  // phones and wide screens.
  float R = max(aspect, 0.7) * 1.45;
  float apex = mix(-0.63, -0.2, lift);
  vec2 C = vec2(0.0, apex - R);
  vec2 q = p - C;
  float h = length(q) - R;                     // height above the limb
  float arc = atan(q.x, q.y) * R;              // distance along the limb from the apex

  // Sun sits on the apex and climbs from behind the planet.
  vec2 S = vec2(0.0, apex + mix(-0.045, 0.006, sunUp));
  vec2 dS = p - S;
  float ds = length(dS);

  float nearWide = exp(-pow(arc / 0.55, 2.0));
  float near = exp(-pow(arc / 0.26, 2.0));
  float nearTight = exp(-pow(arc / 0.075, 2.0));
  float light = mix(0.35, 1.0, sunUp) * mix(0.55, 1.0, smoothstep(0.0, 0.35, rise));

  // Shade each side on its own; across the limb itself (about one pixel)
  // blend the two so the horizon is antialiased instead of stair-stepped.
  float aa = 1.25 / uRes.y;
  vec3 col;
  if (h > aa) {
    col = skySide(h, px, near, nearWide, nearTight, light);
  } else if (h < -aa) {
    col = nightSide(-h, arc, R, near, nearTight, light, sunUp, lift);
  } else {
    col = mix(
      nightSide(max(-h, 0.0), arc, R, near, nearTight, light, sunUp, lift),
      skySide(max(h, 0.0), px, near, nearWide, nearTight, light),
      smoothstep(-aa, aa, h)
    );
  }

  // Sun: the disc is occluded by the planet, the glare (camera) is not.
  float visible = smoothstep(-0.002, 0.003, h);
  float disc = smoothstep(0.016, 0.009, ds) * visible;
  float glow = 0.0035 / (ds * ds + 0.0035);
  float corona = exp(-ds / 0.09);
  // Soft, irregular rays — only in the sky, never painted over the planet.
  float ang = atan(dS.y, dS.x);
  float rays = noise(vec2(ang * 9.0, uTime * 0.05)) * noise(vec2(ang * 23.0 + 3.0, uTime * 0.04));
  rays = pow(rays, 2.0) * smoothstep(0.0, 0.03, h);
  // Anamorphic flare: a hot core that decays fast, plus a faint wide wing.
  float ax = abs(dS.x);
  float streak = exp(-abs(dS.y) / 0.002) * (exp(-ax / 0.14) + 0.1 * exp(-ax / 0.4));
  // The dark planet stays a silhouette: glare is held back below the limb.
  float shade = mix(0.35, 1.0, smoothstep(-0.03, 0.01, h));

  float sunPower = sunUp;
  col += vec3(1.0, 0.98, 0.94) * disc * 3.0 * sunPower;
  col += vec3(1.0, 0.8, 0.58) * glow * 0.5 * sunPower * shade;
  col += vec3(1.0, 0.68, 0.42) * corona * 0.3 * sunPower * shade;
  col += vec3(1.0, 0.84, 0.66) * rays * exp(-ds / 0.16) * 0.55 * sunPower;
  col += vec3(0.72, 0.87, 1.0) * streak * 0.65 * sunPower;

  // Filmic shoulder + ordered noise to kill gradient banding.
  col = 1.0 - exp(-col * 1.15);
  col += (hash12(frag + fract(uTime) * 61.0) - 0.5) / 255.0;

  gl_FragColor = vec4(col, 1.0);
}
`

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`[join sky] shader compile failed: ${log}`)
  }
  return shader
}

/**
 * Creates the sky renderer. Returns null when WebGL is unavailable.
 *   const sky = createSky(canvas, { onLost })
 *   sky.render(timeSeconds, rise)
 */
export function createSky(canvas, { onLost } = {}) {
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
  })
  if (!gl) return null

  const program = gl.createProgram()
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`[join sky] program link failed: ${gl.getProgramInfoLog(program)}`)
  }
  gl.useProgram(program)

  // One oversized triangle covers the viewport.
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const uRes = gl.getUniformLocation(program, 'uRes')
  const uScale = gl.getUniformLocation(program, 'uScale')
  const uTime = gl.getUniformLocation(program, 'uTime')
  const uRise = gl.getUniformLocation(program, 'uRise')

  // Soft gradients don't need full resolution; stars are drawn in CSS px.
  const scale = byTier({ high: Math.min(dpr, 1.5), medium: Math.min(dpr, 1.2), low: Math.min(dpr, 0.9) })
  let width = 0
  let height = 0
  let lost = false

  const resize = (cssWidth, cssHeight) => {
    const w = Math.max(1, Math.round(cssWidth * scale))
    const h = Math.max(1, Math.round(cssHeight * scale))
    if (w === width && h === height) return false
    width = canvas.width = w
    height = canvas.height = h
    gl.viewport(0, 0, w, h)
    return true
  }

  const ro = new ResizeObserver(([entry]) => {
    const box = entry.contentRect
    if (resize(box.width, box.height)) api.onResize?.()
  })
  ro.observe(canvas)

  const handleLost = (event) => {
    event.preventDefault()
    lost = true
    onLost?.()
  }
  canvas.addEventListener('webglcontextlost', handleLost)

  const api = {
    onResize: null,
    render(time, rise) {
      if (lost || !width) return
      gl.uniform2f(uRes, width, height)
      gl.uniform1f(uScale, scale)
      gl.uniform1f(uTime, time)
      gl.uniform1f(uRise, rise)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    get ready() {
      return width > 0 && !lost
    },
    destroy() {
      ro.disconnect()
      canvas.removeEventListener('webglcontextlost', handleLost)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
  return api
}
