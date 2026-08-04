"use client";

import { useEffect, useRef } from "react";

/**
 * The ambient field behind the whole workspace.
 *
 * This is a port of the two reference shaders in `references/design-explorations/`:
 * `shader_1` (ANIMATION_52 — the deep-current caustic the reference workspace
 * embeds verbatim) and `shader_2` (ANIMATION_62 — the prismatic light variant).
 * They are not two palettes of one effect: the dark one ADDS an emerald bloom
 * and a purple undertone to a navy base, while the light one STAINS a white
 * base with an emerald→blue→purple spectrum and adds refractive highlights.
 * Compositing differs, not just colour.
 *
 * They are nonetheless one program with one set of noise samples, because the
 * expensive part is the three simplex calls and running two programs would pay
 * for them twice. `u_light` selects the model; at 0.0 and 1.0 the output is
 * arithmetically identical to the corresponding reference. Between them it
 * crossfades, which is why the uniform is eased rather than snapped — flipping
 * the theme dissolves the field instead of cutting it.
 *
 * Per the theme contract, every colour here arrives as a uniform. A literal
 * baked into the fragment shader is what previously made the light workspace
 * paint a dark wash under a near-white page.
 */

/** Straight from the reference shaders — see the file header for provenance. */
const PALETTE = {
  /** #100A24, the Nomin dark canvas. */
  deepBase: [0.063, 0.039, 0.141],
  /** The light canvas the prismatic variant stains. */
  lightBase: [0.984, 0.984, 1.0],
  /** Logo teal — used as light, never as a filled card. */
  emerald: [0.10, 0.66, 0.62],
  /** Prismatic undertone, dark. */
  purple: [0.35, 0.20, 0.72],
  /** Oceanic spectrum stops, light.
   *
   *  Was a prismatic emerald→blue→PURPLE spread, which on a white page read as
   *  an iridescent sheen — pretty, but not the calm water this product is named
   *  and shaped around. Purple is gone; the light field now runs seafoam →
   *  ocean blue → deep teal, so the two themes are the same water at different
   *  depths rather than two unrelated effects. */
  oceanDeep: [0.19, 0.14, 0.47],
  oceanBlue: [0.34, 0.72, 0.78],
} as const;

const VERTEX_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_texCoord;
  void main() {
    v_texCoord = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;

  uniform float u_time;
  uniform vec2 u_resolution;
  uniform vec2 u_mouse;

  /** 0.0 = deep current (shader_1), 1.0 = prismatic (shader_2). */
  uniform float u_light;

  uniform vec3 u_deepBase;
  uniform vec3 u_lightBase;
  uniform vec3 u_emerald;
  uniform vec3 u_purple;
  uniform vec3 u_oceanDeep;
  uniform vec3 u_oceanBlue;

  varying vec2 v_texCoord;

  vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m; m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 a0 = x - floor(x + 0.5);
    float m1 = 1.79284291400159 - 0.85373472095314 * (a0.x * a0.x + h.x * h.x);
    float m2 = 1.79284291400159 - 0.85373472095314 * (a0.y * a0.y + h.y * h.y);
    float m3 = 1.79284291400159 - 0.85373472095314 * (a0.z * a0.z + h.z * h.z);
    vec3 g;
    g.x  = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m * vec3(m1, m2, m3), g);
  }

  void main() {
    vec2 uv = v_texCoord;
    vec2 p = uv * 2.0 - 1.0;
    p.x *= u_resolution.x / u_resolution.y;

    float t = u_time * 0.03;
    vec2 mouse = u_mouse / u_resolution;
    float L = u_light;

    // The two references sample at different frequencies. Interpolating the
    // frequency rather than picking one keeps each endpoint exact and makes the
    // in-between a dissolve rather than a jump cut.
    float n1 = snoise(uv * mix(1.0, 1.5, L) + vec2(t * 0.4, t * 0.15));
    float n2 = snoise(uv * mix(1.8, 2.5, L) - vec2(t * 0.2, t * 0.35));
    float n3 = snoise(uv * mix(0.6, 0.8, L) + vec2(mouse.x * mix(0.08, 0.05, L), t * mix(0.05, 0.1, L)));

    float intensity = smoothstep(0.1, 0.9, n1 * n2 + n3 * 0.4 + mix(0.3, 0.4, L));

    // Deep current: an emerald bloom lifted out of navy, with a purple
    // undertone so the dark mode never reads as flat grey.
    vec3 deep = mix(u_deepBase, u_deepBase * 1.2 + u_emerald * 0.1, intensity);
    deep = mix(deep, deep + u_purple * 0.05, n2 * 0.5 + 0.5);

    // Nomin light: a nearly white canvas with a faint teal/indigo shader.
    //
    // The stain used to be 8%, which on a near-white page rounded to nothing —
    // It is intentionally much quieter than the old oceanic wash: white stays
    // the primary surface, while the shader gives the empty space depth.
    vec3 spectrum = mix(u_emerald, u_oceanBlue, n1 * 0.5 + 0.5);
    spectrum = mix(spectrum, u_oceanDeep, n2 * 0.5 + 0.5);

    float depth = smoothstep(0.05, 1.0, uv.y);
    vec3 prism = mix(u_lightBase, spectrum, intensity * mix(0.018, 0.065, depth));
    prism = mix(prism, spectrum, pow(intensity, 4.0) * 0.045);

    vec3 color = mix(deep, prism, L);

    // Bioluminescent cursor glow. Identical in both references, and the one
    // place the field reacts to the person using it.
    float dist = length(uv - mouse);
    color += u_emerald * (0.012 / (dist + 0.4)) * intensity;

    // The dark reference vignettes hard for focus; the light one barely at all,
    // because darkening a white page reads as dirt rather than depth.
    float vignette = 1.0 - length(p * mix(0.45, 0.3, L));
    color *= mix(smoothstep(0.0, 1.0, vignette), mix(0.99, 1.0, vignette), L);

    gl_FragColor = vec4(color, 1.0);
  }
`;

export function AmbientCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!context) return;
    const gl = context as WebGLRenderingContext;

    function createShader(type: number, source: string) {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    }

    const vertexShader = createShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = createShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!vertexShader || !fragmentShader || !program) return;

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const uTime = uniform("u_time");
    const uResolution = uniform("u_resolution");
    const uMouse = uniform("u_mouse");
    const uLight = uniform("u_light");

    // Palette uniforms are set once — they are constants of the design, and the
    // theme selects BETWEEN the two models rather than recolouring either.
    gl.uniform3fv(uniform("u_deepBase"), PALETTE.deepBase as unknown as number[]);
    gl.uniform3fv(uniform("u_lightBase"), PALETTE.lightBase as unknown as number[]);
    gl.uniform3fv(uniform("u_emerald"), PALETTE.emerald as unknown as number[]);
    gl.uniform3fv(uniform("u_purple"), PALETTE.purple as unknown as number[]);
    gl.uniform3fv(uniform("u_oceanDeep"), PALETTE.oceanDeep as unknown as number[]);
    gl.uniform3fv(uniform("u_oceanBlue"), PALETTE.oceanBlue as unknown as number[]);

    function syncSize() {
      const width = canvas!.clientWidth || 1280;
      const height = canvas!.clientHeight || 720;
      if (canvas!.width !== width || canvas!.height !== height) {
        canvas!.width = width;
        canvas!.height = height;
      }
    }
    syncSize();

    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncSize) : null;
    resizeObserver?.observe(canvas);

    // Pixel coordinates matching u_resolution, per the reference's ShaderToy
    // convention; the shader normalises with u_mouse / u_resolution.
    const mouse = { x: canvas.width / 2, y: canvas.height / 2 };
    const smoothed = { x: mouse.x, y: mouse.y };

    function onPointerMove(event: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nx = (event.clientX - rect.left) / rect.width;
      const ny = 1 - (event.clientY - rect.top) / rect.height;
      mouse.x = nx * canvas!.width;
      mouse.y = ny * canvas!.height;
    }
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    // Motion is the entire effect, so reduced-motion freezes the field rather
    // than removing it: the composition stays, the drift stops.
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    // Theme is read from the DOM attribute each frame rather than subscribed to,
    // matching how the rest of the UI reads it — React does not own the theme.
    let light = document.documentElement.getAttribute("data-theme") === "light" ? 1 : 0;

    let frame = 0;
    function render(ms: number) {
      const target = document.documentElement.getAttribute("data-theme") === "light" ? 1 : 0;
      // ~0.5s dissolve at 60fps. Snapped when reduced motion is requested.
      light = reducedMotion.matches ? target : light + (target - light) * 0.06;

      // The cursor trails rather than tracks, which is what makes the glow read
      // as a light source moving through water instead of a hotspot pinned to
      // the pointer.
      smoothed.x += (mouse.x - smoothed.x) * 0.05;
      smoothed.y += (mouse.y - smoothed.y) * 0.05;

      gl.viewport(0, 0, canvas!.width, canvas!.height);
      if (uTime) gl.uniform1f(uTime, reducedMotion.matches ? 0 : ms * 0.001);
      if (uResolution) gl.uniform2f(uResolution, canvas!.width, canvas!.height);
      if (uMouse) gl.uniform2f(uMouse, smoothed.x, smoothed.y);
      if (uLight) gl.uniform1f(uLight, light);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      frame = requestAnimationFrame(render);
    }
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointerMove);
      resizeObserver?.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
  }, []);

  return <canvas className="ambientCanvas" ref={canvasRef} aria-hidden="true" />;
}
