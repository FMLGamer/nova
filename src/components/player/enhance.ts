import { useEffect } from 'react';

/**
 * Real-time video enhancement in WebGL: the video is drawn into a canvas at the
 * display's native resolution through a chain of fragment shaders. Every pass
 * receives the previous output as `tex` (the first one gets the video frame).
 *
 * Custom chains: write passes separated by a line `//!PASS`. Each pass must define
 *   vec4 hook(sampler2D tex, vec2 uv, vec2 px)   // px = 1 / input size
 */

const VERT = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2(p.x*.5+.5, .5-p.y*.5); gl_Position = vec4(p,0.,1.); }`;

const frag = (body: string) => `#version 300 es
precision highp float;
uniform sampler2D tex; uniform vec2 px; uniform float t;
in vec2 uv; out vec4 o;
float luma(vec3 c){ return dot(c, vec3(.299,.587,.114)); }
${body}
void main(){ o = hook(tex, uv, px); }`;

/** AMD FidelityFX CAS-style contrast-adaptive sharpening. */
const CAS = `
vec4 hook(sampler2D tex, vec2 uv, vec2 px){
  vec3 a=texture(tex,uv+vec2(0.,-px.y)).rgb, b=texture(tex,uv+vec2(-px.x,0.)).rgb, c=texture(tex,uv).rgb,
       d=texture(tex,uv+vec2(px.x,0.)).rgb, e=texture(tex,uv+vec2(0.,px.y)).rgb;
  vec3 mn=min(min(min(a,b),min(d,e)),c), mx=max(max(max(a,b),max(d,e)),c);
  vec3 amp=sqrt(clamp(min(mn,2.-mx)/max(mx,1e-4),0.,1.));
  vec3 w=-amp*0.2;
  return vec4(clamp((c+(a+b+d+e)*w)/(1.+4.*w),0.,1.),1.);
}`;

/**
 * Anime4K-style line refinement (after the v0.9 "push" idea): find the luminance
 * gradient, thin and darken line art toward its darkest neighbour, then push the
 * colour toward the gradient's high side — crisp edges on flat-shaded animation.
 */
const ANIME4K_THIN = `
vec4 hook(sampler2D tex, vec2 uv, vec2 px){
  vec3 c=texture(tex,uv).rgb; float L=luma(c);
  vec3 n[8]; float l[8];
  vec2 o[8]=vec2[8](vec2(-1,-1),vec2(0,-1),vec2(1,-1),vec2(-1,0),vec2(1,0),vec2(-1,1),vec2(0,1),vec2(1,1));
  float mn=L; vec3 darkest=c;
  for(int i=0;i<8;i++){ n[i]=texture(tex,uv+o[i]*px).rgb; l[i]=luma(n[i]); if(l[i]<mn){mn=l[i];darkest=n[i];} }
  float gx=(l[2]+2.*l[4]+l[7])-(l[0]+2.*l[3]+l[5]);
  float gy=(l[5]+2.*l[6]+l[7])-(l[0]+2.*l[1]+l[2]);
  float g=clamp(sqrt(gx*gx+gy*gy)*1.6,0.,1.);
  // Only thin dark strokes; leave soft shading alone.
  float line=smoothstep(.18,.55,g)*step(mn+.02,L);
  return vec4(mix(c,darkest,line*.55),1.);
}`;

const ANIME4K_PUSH = `
vec4 hook(sampler2D tex, vec2 uv, vec2 px){
  vec3 c=texture(tex,uv).rgb;
  float tl=luma(texture(tex,uv+vec2(-px.x,-px.y)).rgb), t=luma(texture(tex,uv+vec2(0.,-px.y)).rgb), tr=luma(texture(tex,uv+vec2(px.x,-px.y)).rgb);
  float l=luma(texture(tex,uv+vec2(-px.x,0.)).rgb), r=luma(texture(tex,uv+vec2(px.x,0.)).rgb);
  float bl=luma(texture(tex,uv+vec2(-px.x,px.y)).rgb), b=luma(texture(tex,uv+vec2(0.,px.y)).rgb), br=luma(texture(tex,uv+vec2(px.x,px.y)).rgb);
  vec2 g=vec2((tr+2.*r+br)-(tl+2.*l+bl),(bl+2.*b+br)-(tl+2.*t+tr));
  float m=length(g); if(m<.04) return vec4(c,1.);
  vec2 dir=normalize(g)*px*.75;
  vec3 hi=texture(tex,uv+dir).rgb;
  return vec4(mix(c,hi,clamp(m*.9,0.,.45)),1.);
}`;

/** Gradient-preserving debanding with a touch of dither. */
const DEBAND = `
float h(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
vec4 hook(sampler2D tex, vec2 uv, vec2 px){
  vec3 c=texture(tex,uv).rgb;
  float r=h(uv+t)*16.+4.; float a=h(uv*1.7+t)*6.2831;
  vec2 d=vec2(cos(a),sin(a))*r*px;
  vec3 s1=texture(tex,uv+d).rgb, s2=texture(tex,uv-d).rgb, s3=texture(tex,uv+vec2(-d.y,d.x)).rgb, s4=texture(tex,uv+vec2(d.y,-d.x)).rgb;
  vec3 avg=(s1+s2+s3+s4)*.25;
  vec3 diff=max(max(abs(s1-c),abs(s2-c)),max(abs(s3-c),abs(s4-c)));
  vec3 outc=mix(avg,c,step(.012,diff));
  return vec4(outc+(h(uv*vec2(913.,457.)+t)-.5)/255.,1.);
}`;

const COPY = `vec4 hook(sampler2D tex, vec2 uv, vec2 px){ return texture(tex,uv); }`;

export type EnhanceMode = 'none' | 'sharpen' | 'anime4k' | 'deband' | 'custom';

export function passesFor(mode: EnhanceMode, custom: string): string[] {
  if (mode === 'sharpen') return [CAS];
  if (mode === 'anime4k') return [ANIME4K_THIN, ANIME4K_PUSH, CAS];
  if (mode === 'deband') return [DEBAND];
  if (mode === 'custom') {
    const parts = custom.split(/^\s*\/\/!PASS\s*$/m).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : [COPY];
  }
  return [];
}

interface Pass {
  prog: WebGLProgram;
  loc: { tex: WebGLUniformLocation | null; px: WebGLUniformLocation | null; t: WebGLUniformLocation | null };
}

function compile(gl: WebGL2RenderingContext, body: string): Pass {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'Shader failed to compile');
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, mk(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, frag(body)));
  gl.bindAttribLocation(prog, 0, 'p');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'Shader failed to link');
  return { prog, loc: { tex: gl.getUniformLocation(prog, 'tex'), px: gl.getUniformLocation(prog, 'px'), t: gl.getUniformLocation(prog, 't') } };
}

/** Drives the canvas while `mode` is active. Calls onError (and stops) if the GPU path fails. */
export function useEnhancer(
  video: HTMLVideoElement | null,
  canvas: HTMLCanvasElement | null,
  mode: EnhanceMode,
  custom: string,
  onError: (msg: string) => void,
) {
  useEffect(() => {
    if (!video || !canvas || mode === 'none') return;
    // Not desynchronized: a front-buffer canvas flickers against the video overlay on Windows.
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: false });
    if (!gl) {
      onError('WebGL2 is not available on this device');
      return;
    }
    let passes: Pass[];
    try {
      passes = passesFor(mode, custom).map((b) => compile(gl, b));
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Shader error');
      return;
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const mkTex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const src = mkTex();
    const targets = [0, 1].map(() => ({ tex: mkTex(), fb: gl.createFramebuffer()!, w: 0, h: 0 }));

    let stopped = false;
    let handle = 0;
    const draw = () => {
      if (stopped) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Fit the video's aspect inside the canvas box (letterbox like object-fit: contain).
      const vw = video.videoWidth || 16;
      const vh = video.videoHeight || 9;
      const scale = Math.min(rect.width / vw, rect.height / vh);
      const W = Math.max(2, Math.round(vw * scale * dpr));
      const H = Math.max(2, Math.round(vh * scale * dpr));
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      if (video.readyState >= 2) {
        gl.bindTexture(gl.TEXTURE_2D, src);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        let input = src;
        let inW = vw;
        let inH = vh;
        passes.forEach((p, i) => {
          const last = i === passes.length - 1;
          const target = targets[i % 2]!;
          if (!last && (target.w !== W || target.h !== H)) {
            gl.bindTexture(gl.TEXTURE_2D, target.tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
            target.w = W;
            target.h = H;
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, last ? null : target.fb);
          gl.viewport(0, 0, W, H);
          gl.useProgram(p.prog);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, input);
          gl.uniform1i(p.loc.tex, 0);
          gl.uniform2f(p.loc.px, 1 / inW, 1 / inH);
          gl.uniform1f(p.loc.t, (performance.now() % 10000) / 10000);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          input = target.tex;
          inW = W;
          inH = H;
        });
      }
      schedule();
    };
    const rvfc = 'requestVideoFrameCallback' in video;
    let usedRvfc = false;
    const schedule = () => {
      if (stopped) return;
      usedRvfc = rvfc && !video.paused;
      handle = usedRvfc ? video.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
    };
    schedule();
    return () => {
      stopped = true;
      if (usedRvfc) video.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      // Free GPU objects but keep the context: a lost context can't be re-acquired from the same canvas.
      passes.forEach((p) => gl.deleteProgram(p.prog));
      [src, ...targets.map((t) => t.tex)].forEach((t) => gl.deleteTexture(t));
      targets.forEach((t) => gl.deleteFramebuffer(t.fb));
      gl.deleteBuffer(buf);
    };
  }, [video, canvas, mode, custom, onError]);
}
