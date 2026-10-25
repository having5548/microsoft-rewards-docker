/**
 * iOS Liquid Glass & WebGL2 Dynamic Shader Background
 * Features 5 distinct visual styles:
 * 1. 极光深色流体网格 (Aurora Fluid Mesh)
 * 2. 拟真流体动力学 (Fluid Dynamics Waves)
 * 3. 柔焦 3D 悬浮几何体 (Floating 3D Polyhedra)
 * 4. 极暗磨砂星云噪点 (Deep Matte Nebula Noise)
 * 5. 霓虹脉冲等高线 (Cyber Contour Waves)
 */
(function () {
  'use strict';

  const COLOR_THEMES = {
    aurora: {
      base: [0.025, 0.03, 0.06],
      mid: [0.18, 0.16, 0.46],
      accent: [0.98, 0.067, 0.31],
      highlight: [0.0, 0.96, 0.83]
    },
    sunset: {
      base: [0.045, 0.025, 0.06],
      mid: [0.32, 0.08, 0.38],
      accent: [0.96, 0.25, 0.37],
      highlight: [0.96, 0.62, 0.04]
    },
    ocean: {
      base: [0.01, 0.03, 0.07],
      mid: [0.02, 0.1, 0.25],
      accent: [0.01, 0.52, 0.78],
      highlight: [0.02, 0.71, 0.83]
    },
    emerald: {
      base: [0.01, 0.04, 0.03],
      mid: [0.02, 0.16, 0.1],
      accent: [0.06, 0.72, 0.5],
      highlight: [0.63, 1.0, 0.0]
    },
    monochrome: {
      base: [0.02, 0.03, 0.05],
      mid: [0.15, 0.2, 0.27],
      accent: [0.37, 0.45, 0.55],
      highlight: [0.8, 0.84, 0.88]
    }
  };

  const STYLE_INDICES = {
    silk: 0,
    grainient: 1,
    veil: 2,
    aurora: 3,
    prism: 4
  };

  class LiquidBgEngine {
    constructor() {
      this.canvas = null;
      this.gl = null;
      this.program = null;
      this.animId = null;
      this.startTime = performance.now();
      this.enabled = true;
      this.style = 'grainient';
      this.theme = 'aurora';
      this.speed = 1.0;
      this.noise = 0.25;
      this.turbulence = 1.0;
      this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || false;

      this.mouse = { x: 0.5, y: 0.5, targetX: 0.5, targetY: 0.5, vx: 0, vy: 0 };
      this.uniforms = {};
      this.isWebGL2 = false;

      this.handleResize = this.handleResize.bind(this);
      this.handleMouseMove = this.handleMouseMove.bind(this);
      this.handleVisibility = this.handleVisibility.bind(this);
      this.handleMotionPreference = this.handleMotionPreference.bind(this);
      this.render = this.render.bind(this);
      this.motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
    }

    init(canvasId = 'bg-webgl-canvas') {
      this.canvas = document.getElementById(canvasId);
      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.canvas.id = canvasId;
        this.canvas.className = 'bg-webgl-canvas';
        document.body.prepend(this.canvas);
      }

      const opts = {
        alpha: false,
        depth: false,
        stencil: false,
        antialias: false,
        powerPreference: 'high-performance'
      };

      try {
        this.gl = this.canvas.getContext('webgl2', opts);
        if (this.gl) this.isWebGL2 = true;
      } catch (e) {}

      if (!this.gl) {
        try {
          this.gl = this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
        } catch (e) {}
      }

      if (!this.gl) {
        console.warn('[WebGL2] WebGL context unavailable, dynamic background disabled.');
        return false;
      }

      this.initShaders();
      this.initBuffers();
      this.handleResize();

      window.addEventListener('resize', this.handleResize, { passive: true });
      window.addEventListener('mousemove', this.handleMouseMove, { passive: true });
      document.addEventListener('visibilitychange', this.handleVisibility);
      this.motionQuery?.addEventListener?.('change', this.handleMotionPreference);

      if (this.enabled) {
        this.start();
      }
      return true;
    }

    initShaders() {
      const gl = this.gl;

      const vsSource = this.isWebGL2 ? `#version 300 es
        in vec2 a_pos;
        out vec2 v_uv;
        void main() {
          v_uv = a_pos * 0.5 + 0.5;
          gl_Position = vec4(a_pos, 0.0, 1.0);
        }
      ` : `
        attribute vec2 a_pos;
        varying vec2 v_uv;
        void main() {
          v_uv = a_pos * 0.5 + 0.5;
          gl_Position = vec4(a_pos, 0.0, 1.0);
        }
      `;

      const fsSource = this.isWebGL2 ? `#version 300 es
        precision highp float;
        in vec2 v_uv;
        out vec4 fragColor;

        uniform vec2 u_res;
        uniform float u_time;
        uniform vec2 u_mouse;
        uniform vec2 u_mouse_vel;
        uniform float u_speed;
        uniform float u_noise;
        uniform float u_turb;
        uniform int u_style;

        uniform vec3 u_color_base;
        uniform vec3 u_color_mid;
        uniform vec3 u_color_accent;
        uniform vec3 u_color_highlight;

        // Fast hash & noise functions
        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
          for (int i = 0; i < 4; i++) {
            v += a * noise(p);
            p = rot * p * 2.05;
            a *= 0.5;
          }
          return v;
        }

        mat2 rotate2(float angle) {
          float c = cos(angle);
          float s = sin(angle);
          return mat2(c, -s, s, c);
        }

        vec2 warpedPoint(vec2 uv) {
          vec2 p = (uv - 0.5) * 2.0;
          p.x *= u_res.x / u_res.y;
          vec2 mouse = (u_mouse - 0.5) * 2.0;
          vec2 delta = p - mouse;
          p -= delta * exp(-dot(delta, delta) * 2.4) * u_turb * 0.035;
          return p;
        }

        // 1. Silk: satin folds with directional specular light.
        float silkPattern(vec2 p, float t) {
          vec2 q = rotate2(0.42 + sin(t * 0.05) * 0.08) * p;
          float fold = sin(
            5.2 * (q.x + q.y + cos(3.0 * q.x + 5.0 * q.y)) +
            0.02 * t +
            sin(18.0 * (q.x + q.y - 0.03 * t))
          );
          return 0.5 + 0.5 * fold;
        }

        vec3 renderSilk(vec2 uv, float t) {
          vec2 p = warpedPoint(uv);
          float n = smoothstep(0.18, 0.9, silkPattern(p, t));
          float dx = silkPattern(p + vec2(0.004, 0.0), t) - silkPattern(p - vec2(0.004, 0.0), t);
          float dy = silkPattern(p + vec2(0.0, 0.004), t) - silkPattern(p - vec2(0.0, 0.004), t);
          vec3 normal = normalize(vec3(-dx * 3.2, -dy * 3.2, 1.0));
          vec3 lightDir = normalize(vec3(-0.55, 0.7, 0.9));
          float diffuse = max(dot(normal, lightDir), 0.0);
          float gloss = pow(max(dot(normal, normalize(lightDir + vec3(0.0, 0.0, 1.0))), 0.0), 38.0);

          vec3 col = mix(u_color_base, u_color_mid, 0.2 + n * 0.5);
          col = mix(col, u_color_accent, smoothstep(0.55, 0.95, n) * 0.34);
          col *= 0.72 + diffuse * 0.34;
          col += u_color_highlight * gloss * 0.32;
          return col;
        }

        // 2. Grainient: soft flowing color ramp with organic domain warp.
        vec3 renderGrainient(vec2 uv, float t) {
          vec2 p = warpedPoint(uv);
          vec2 flow = vec2(
            fbm(p * 0.82 + vec2(t * 0.035, 2.7)),
            fbm(p * 0.82 + vec2(5.1, -t * 0.03))
          ) - 0.5;
          p += flow * 0.65;
          vec2 dir = normalize(vec2(0.78, 0.62));
          float raw = clamp(dot(p, dir) * 0.5 + 0.5, 0.0, 1.0);
          float s = smoothstep(0.06, 0.94, raw);

          vec3 col = mix(u_color_base, u_color_mid, smoothstep(0.0, 0.58, s));
          col = mix(col, u_color_accent, smoothstep(0.46, 0.84, s) * 0.68);
          col = mix(col, u_color_highlight, smoothstep(0.82, 1.0, s) * 0.36);
          float silk = sin((s * 7.0 + t * 0.08) * 3.1415926);
          col += u_color_highlight * pow(max(0.0, silk), 16.0) * 0.08;
          return col;
        }

        // 3. Dark Veil: deep fluid folds with restrained luminous crests.
        vec3 renderVeil(vec2 uv, float t) {
          vec2 p = warpedPoint(uv);
          float f1 = fbm(p * 1.15 + vec2(t * 0.035, -t * 0.025));
          vec2 q = p + vec2(f1 - 0.5, fbm(p * 1.35 + vec2(3.4, t * 0.03)) - 0.5) * 0.85;
          float veil = fbm(q * 2.0 + vec2(-t * 0.045, t * 0.02));
          float crest = pow(smoothstep(0.38, 0.92, veil), 3.4);
          float fold = smoothstep(0.12, 0.9, fbm(q * 0.9 - vec2(t * 0.025)));

          vec3 col = u_color_base;
          col = mix(col, u_color_mid, fold * 0.4);
          col += u_color_accent * crest * 0.3;
          col += u_color_highlight * pow(crest, 2.2) * 0.17;
          return col;
        }

        // 4. Soft Aurora: layered luminous ribbons with a wide, quiet falloff.
        vec3 renderSoftAurora(vec2 uv, float t) {
          vec2 p = warpedPoint(uv);
          float field = fbm(vec2(p.x * 1.05 + t * 0.055, p.y * 0.75 - t * 0.025));
          float y1 = 0.16 * sin(p.x * 1.9 + t * 0.13) + 0.12 * field;
          float y2 = -0.24 + 0.18 * cos(p.x * 1.45 - t * 0.1) + 0.1 * field;
          float band1 = exp(-pow((p.y - y1) * 3.0, 2.0));
          float band2 = exp(-pow((p.y - y2) * 3.8, 2.0));
          float side = smoothstep(-1.7, 1.6, p.x);

          vec3 col = mix(u_color_base, u_color_mid, field * 0.22);
          col += u_color_accent * band1 * (0.18 + side * 0.18);
          col += u_color_highlight * band2 * 0.2;
          col += u_color_mid * pow(field, 3.0) * 0.18;
          return col;
        }

        // 5. Prism: narrow spectral light curtains over a dark base.
        vec3 renderPrism(vec2 uv, float t) {
          vec2 p = warpedPoint(uv);
          float noiseField = fbm(p * 1.3 + vec2(t * 0.025, -t * 0.02));
          float angle = atan(p.y + 0.18, p.x + 0.24);
          float radius = length(p + vec2(0.24, -0.18));
          float rays = pow(max(0.0, sin(angle * 8.0 + noiseField * 3.5 + t * 0.16)), 12.0);
          rays *= exp(-radius * 1.1);
          float curtain = pow(max(0.0, sin((p.x * 0.72 + p.y) * 4.2 - t * 0.22 + noiseField * 2.0)), 18.0);

          vec3 col = mix(u_color_base, u_color_mid, noiseField * 0.2);
          col += u_color_accent * rays * 0.42;
          col += u_color_highlight * curtain * 0.28;
          col += mix(u_color_accent, u_color_highlight, 0.5) * rays * curtain * 0.45;
          return col;
        }

        void main() {
          float t = u_time * u_speed;
          vec3 col;

          if (u_style == 0) col = renderSilk(v_uv, t);
          else if (u_style == 1) col = renderGrainient(v_uv, t);
          else if (u_style == 2) col = renderVeil(v_uv, t);
          else if (u_style == 3) col = renderSoftAurora(v_uv, t);
          else if (u_style == 4) col = renderPrism(v_uv, t);
          else col = renderSilk(v_uv, t);

          // Subtle tactile film grain
          float grain = (hash(v_uv * u_res + fract(u_time * 23.1)) - 0.5) * u_noise * 0.12;
          col += grain;

          // Filmic tone mapping keeps the backdrop deep enough for glass contrast.
          col = col / (1.0 + col * 0.9);
          col *= 0.66;

          // Soft vignette for luxury depth and legibility around the edges.
          float vign = 1.0 - smoothstep(0.15, 0.78, length(v_uv - 0.5));
          col *= mix(0.55, 1.0, vign);

          fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      ` : `
        precision mediump float;
        varying vec2 v_uv;
        uniform vec2 u_res;
        uniform float u_time;
        uniform vec2 u_mouse;
        uniform float u_speed;
        uniform float u_noise;
        uniform float u_turb;
        uniform int u_style;

        uniform vec3 u_color_base;
        uniform vec3 u_color_mid;
        uniform vec3 u_color_accent;
        uniform vec3 u_color_highlight;

        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        void main() {
          float t = u_time * u_speed * 0.3;
          vec2 p = v_uv * 2.0 - 1.0;
          p.x *= u_res.x / u_res.y;

          float w = sin(p.x * 2.5 + t) * cos(p.y * 2.5 - t);
          vec3 col = mix(u_color_base, u_color_mid, w * 0.5 + 0.5);
          col += u_color_accent * pow(max(0.0, sin(p.y * 3.0 + w * 2.0 + t)), 4.0) * 0.5;

          float grain = (hash(v_uv * u_res + fract(u_time * 17.0)) - 0.5) * u_noise * 0.1;
          col += grain;
          col = col / (1.0 + col * 0.9);
          col *= 0.66;
          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `;

      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vsSource);
      gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        console.error('[WebGL VS]', gl.getShaderInfoLog(vs));
      }

      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fsSource);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        console.error('[WebGL FS]', gl.getShaderInfoLog(fs));
      }

      this.program = gl.createProgram();
      gl.attachShader(this.program, vs);
      gl.attachShader(this.program, fs);
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
        console.error('[WebGL Program]', gl.getProgramInfoLog(this.program));
      }

      gl.useProgram(this.program);

      // Cache uniform locations
      const uNames = [
        'u_res', 'u_time', 'u_mouse', 'u_mouse_vel', 'u_speed',
        'u_noise', 'u_turb', 'u_style',
        'u_color_base', 'u_color_mid', 'u_color_accent', 'u_color_highlight'
      ];
      for (const name of uNames) {
        this.uniforms[name] = gl.getUniformLocation(this.program, name);
      }
    }

    initBuffers() {
      const gl = this.gl;
      const posAttr = gl.getAttribLocation(this.program, 'a_pos');
      const quadVertices = new Float32Array([
        -1.0, -1.0,
         1.0, -1.0,
        -1.0,  1.0,
        -1.0,  1.0,
         1.0, -1.0,
         1.0,  1.0
      ]);

      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

      gl.enableVertexAttribArray(posAttr);
      gl.vertexAttribPointer(posAttr, 2, gl.FLOAT, false, 0, 0);
    }

    handleResize() {
      if (!this.canvas || !this.gl) return;
      // Cap device pixel ratio at 1.25 to guarantee 60 FPS without high energy use
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      const w = Math.floor(window.innerWidth * dpr);
      const h = Math.floor(window.innerHeight * dpr);

      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
        this.gl.viewport(0, 0, w, h);
      }
    }

    handleMouseMove(e) {
      const targetX = e.clientX / window.innerWidth;
      const targetY = 1.0 - (e.clientY / window.innerHeight); // Flip Y for WebGL
      this.mouse.targetX = targetX;
      this.mouse.targetY = targetY;
    }

    handleVisibility() {
      if (document.hidden) {
        this.stop();
      } else if (this.enabled) {
        this.start();
      }
    }

    handleMotionPreference(event) {
      this.reducedMotion = !!event.matches;
    }

    start() {
      if (this.animId) return;
      this.startTime = performance.now();
      this.render();
    }

    stop() {
      if (this.animId) {
        cancelAnimationFrame(this.animId);
        this.animId = null;
      }
    }

    setStyle(styleName) {
      const aliases = { fluid: 'silk', geometry: 'prism', nebula: 'veil', cyber: 'prism' };
      const normalized = aliases[styleName] || styleName;
      if (STYLE_INDICES[normalized] !== undefined) {
        this.style = normalized;
      }
    }

    setTheme(themeName) {
      const aliases = { purple: 'sunset', amber: 'sunset', titanium: 'monochrome' };
      const normalized = aliases[themeName] || themeName;
      if (COLOR_THEMES[normalized]) {
        this.theme = normalized;
      }
    }

    setSpeed(speed) {
      this.speed = Math.max(0.1, Math.min(3.5, Number(speed) || 1.0));
    }

    setNoise(noise) {
      const value = Number(noise);
      this.noise = Number.isFinite(value) ? Math.max(0.0, Math.min(1.0, value)) : 0.25;
    }

    setTurbulence(turb) {
      const value = Number(turb);
      this.turbulence = Number.isFinite(value) ? Math.max(0.0, Math.min(2.5, value)) : 1.0;
    }

    setEnabled(enabled) {
      this.enabled = !!enabled;
      if (this.canvas) {
        this.canvas.style.display = this.enabled ? 'block' : 'none';
      }
      if (this.enabled) {
        this.start();
      } else {
        this.stop();
      }
    }

    render() {
      if (!this.enabled || !this.gl || !this.program) return;

      const gl = this.gl;
      gl.useProgram(this.program);

      // Smooth mouse lerping
      const lerpFactor = 0.08;
      const dx = this.mouse.targetX - this.mouse.x;
      const dy = this.mouse.targetY - this.mouse.y;
      this.mouse.x += dx * lerpFactor;
      this.mouse.y += dy * lerpFactor;
      this.mouse.vx = dx;
      this.mouse.vy = dy;

      const now = (performance.now() - this.startTime) * 0.001;
      const motionScale = this.reducedMotion ? 0.18 : 1;

      // Pass uniforms
      if (this.uniforms.u_res) gl.uniform2f(this.uniforms.u_res, this.canvas.width, this.canvas.height);
      if (this.uniforms.u_time) gl.uniform1f(this.uniforms.u_time, now);
      if (this.uniforms.u_mouse) gl.uniform2f(this.uniforms.u_mouse, this.mouse.x, this.mouse.y);
      if (this.uniforms.u_mouse_vel) gl.uniform2f(this.uniforms.u_mouse_vel, this.mouse.vx, this.mouse.vy);
      if (this.uniforms.u_speed) gl.uniform1f(this.uniforms.u_speed, this.speed * motionScale);
      if (this.uniforms.u_noise) gl.uniform1f(this.uniforms.u_noise, this.noise);
      if (this.uniforms.u_turb) gl.uniform1f(this.uniforms.u_turb, this.turbulence);

      const styleIdx = STYLE_INDICES[this.style] !== undefined ? STYLE_INDICES[this.style] : 0;
      if (this.uniforms.u_style) gl.uniform1i(this.uniforms.u_style, styleIdx);

      const colors = COLOR_THEMES[this.theme] || COLOR_THEMES.aurora;
      if (this.uniforms.u_color_base) gl.uniform3fv(this.uniforms.u_color_base, colors.base);
      if (this.uniforms.u_color_mid) gl.uniform3fv(this.uniforms.u_color_mid, colors.mid);
      if (this.uniforms.u_color_accent) gl.uniform3fv(this.uniforms.u_color_accent, colors.accent);
      if (this.uniforms.u_color_highlight) gl.uniform3fv(this.uniforms.u_color_highlight, colors.highlight);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      this.animId = requestAnimationFrame(this.render);
    }

    destroy() {
      this.stop();
      window.removeEventListener('resize', this.handleResize);
      window.removeEventListener('mousemove', this.handleMouseMove);
      document.removeEventListener('visibilitychange', this.handleVisibility);
      this.motionQuery?.removeEventListener?.('change', this.handleMotionPreference);
      if (this.canvas && this.canvas.parentNode) {
        this.canvas.parentNode.removeChild(this.canvas);
      }
    }
  }

  // Export globally
  window.LiquidBg = new LiquidBgEngine();

  // Auto initialize on DOMContentLoaded if not already initialized
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.LiquidBg.init();
    });
  } else {
    window.LiquidBg.init();
  }
})();
