// The Vesper orb: a drop of International Klein Blue ink suspended in glass.
// Interior is domain-warped noise lit as a volume; the edge deforms only with
// real audio level; each running agent is a satellite on a tilted orbit.

export const VERT = `#version 300 es
in vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }`

export const FRAG = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform float uFlowTime;
uniform float uLevel;
uniform float uWobble;
uniform float uHalo;
uniform float uBreath;
uniform float uFil;
uniform vec3 uCore;
uniform vec3 uMid;
uniform vec3 uHi;
uniform vec3 uRim;
uniform vec3 uIrid;
uniform vec3 uTop;
uniform vec3 uMoon;
uniform int uMoons;
uniform float uRadius;
out vec4 outColor;

vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dot(hash3(i), f), dot(hash3(i + vec3(1, 0, 0)), f - vec3(1, 0, 0)), u.x),
        mix(dot(hash3(i + vec3(0, 1, 0)), f - vec3(0, 1, 0)), dot(hash3(i + vec3(1, 1, 0)), f - vec3(1, 1, 0)), u.x), u.y),
    mix(mix(dot(hash3(i + vec3(0, 0, 1)), f - vec3(0, 0, 1)), dot(hash3(i + vec3(1, 0, 1)), f - vec3(1, 0, 1)), u.x),
        mix(dot(hash3(i + vec3(0, 1, 1)), f - vec3(0, 1, 1)), dot(hash3(i + vec3(1, 1, 1)), f - vec3(1, 1, 1)), u.x), u.y),
    u.z);
}

float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * noise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}

vec2 rot(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

void main() {
  float unit = 0.5 * min(uRes.x, uRes.y);
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / unit;
  float px = 1.0 / unit;
  float t = uTime;
  float ft = uFlowTime;

  float r = length(uv);
  float ang = atan(uv.y, uv.x);
  float R = uRadius * (1.0 + uBreath);
  vec2 dir = vec2(cos(ang), sin(ang));
  float edge = noise(vec3(dir * 1.5, t * 0.8)) * uWobble + noise(vec3(dir * 4.2, t * 2.1)) * uWobble * 0.45;
  float Rd = R * (1.0 + edge);

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  if (r < Rd + px) {
    vec2 p = uv / Rd;
    float z = sqrt(max(0.0, 1.0 - dot(p, p)));
    vec3 n = normalize(vec3(p, z));

    // Ink: a slowly folding cloud, warped by two lower-frequency fields for depth.
    vec2 pp = p * (1.0 + 0.18 * (1.0 - z));
    float wa = fbm(vec3(pp * 1.15, ft * 0.32));
    float wb = fbm(vec3(pp * 1.15 + 4.3, -ft * 0.27));
    vec2 wp = pp + 0.6 * vec2(wa, wb);
    float dens = fbm(vec3(wp * 1.55, ft * 0.22 + 3.0));
    float cloud = smoothstep(-0.28, 0.42, dens);

    // Tendrils: ridged noise gives soft veins instead of contour lines.
    float rn = 1.0 - abs(fbm(vec3(wp * 2.4 + 1.3, ft * 0.38)) * 2.3);
    float tendril = pow(clamp(rn, 0.0, 1.0), 7.0) * smoothstep(0.15, 0.7, cloud) * uFil;

    // Pearl glass: a luminous body with soft light currents moving inside it.
    float light = exp(-length(p - vec2(-0.08, -0.12)) * 1.6);
    vec3 ink = mix(uCore, uMid, 0.35 + 0.5 * cloud);
    ink = mix(ink, uHi, smoothstep(0.45, 1.0, cloud) * 0.3 + light * 0.12);
    ink += uHi * tendril * (0.18 + 0.5 * uLevel);

    // Iridescence: a lavender cast toward the lower left, a cool cyan lift up top.
    float irid = clamp(dot(n, normalize(vec3(-0.65, -0.6, 0.45))), 0.0, 1.0);
    ink = mix(ink, uIrid, irid * irid * 0.5);
    float top = clamp(dot(n, normalize(vec3(0.25, 0.85, 0.45))), 0.0, 1.0);
    ink = mix(ink, uTop, top * 0.18);

    // Glass: bright fresnel rim, softer center, a faint inner reflection ring.
    float fres = pow(1.0 - z, 2.4);
    ink *= 0.74 + 0.2 * z;
    ink += uRim * fres * (1.05 + uLevel * 0.9);
    float ring = smoothstep(0.035, 0.0, abs(length(p) - 0.93));
    ink += uHi * ring * 0.12 * (0.4 + 0.6 * smoothstep(-0.3, 0.9, p.y));

    // Window reflection and glint.
    vec2 hp = rot(p - vec2(-0.3, 0.42), 0.6);
    ink += vec3(0.95, 0.98, 1.0) * exp(-(hp.x * hp.x * 9.0 + hp.y * hp.y * 38.0)) * 0.28;
    ink += vec3(1.0) * exp(-length(p - vec2(-0.24, 0.5)) * 30.0) * 0.3;

    // Real audio lifts the glow from inside.
    ink += uHi * light * uLevel * 0.35;
    ink = min(ink, vec3(1.15));

    alpha = 1.0 - smoothstep(Rd - 1.5 * px, Rd + px, r);
    col = ink;
  }

  // Halo: light the ink throws onto the dark around it.
  float d = max(r - Rd, 0.0);
  float halo = (exp(-d * 5.5) * 0.55 + exp(-d * 18.0) * 0.45) * uHalo;
  // Fade to nothing before the canvas edge so the glow never shows a boundary.
  halo *= smoothstep(1.0, 0.7, r);
  vec3 haloCol = mix(uRim, uHi, 0.4) * halo * 0.9;

  // Satellites: one per running agent, on a tilted orbit that passes behind the orb.
  vec3 moons = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= uMoons) break;
    float a = t * (0.42 + 0.07 * float(i)) + float(i) * 2.39;
    vec2 m = vec2(cos(a) * R * 1.42, sin(a) * R * 0.38);
    m = rot(m, -0.38 + 0.21 * float(i));
    float behind = step(sin(a), 0.0) * step(length(m), Rd);
    float dm = length(uv - m);
    float dot_ = smoothstep(0.022, 0.012, dm) + exp(-dm * 38.0) * 0.6;
    // A short luminous wake behind each satellite.
    for (int k = 1; k < 6; k++) {
      float ak = a - float(k) * 0.07;
      vec2 mk = rot(vec2(cos(ak) * R * 1.42, sin(ak) * R * 0.38), -0.38 + 0.21 * float(i));
      dot_ += exp(-length(uv - mk) * 70.0) * (0.35 - float(k) * 0.055);
    }
    moons += (1.0 - behind) * dot_ * uMoon;
  }

  vec3 outc = col * alpha + haloCol * (1.0 - alpha) + moons;
  float outa = clamp(max(alpha, halo * 0.85 + length(moons)), 0.0, 1.0);
  outColor = vec4(outc, outa);
}`
