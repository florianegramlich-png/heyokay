'use client';

import { useEffect, useRef } from 'react';

/**
 * The night-sky background from the v0 design: slowly drifting cyan and purple stars.
 * Calmer than the original (slower, fewer stars) and still for people who prefer reduced motion.
 */
export function Galaxy() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const colors = ['#06b6d4', '#8b5cf6', '#d946ef'];
    let stars: { x: number; y: number; r: number; c: string; v: number; a: number }[] = [];

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const n = Math.floor((canvas.width * canvas.height) / 6000);
      stars = Array.from({ length: n }, () => ({
        x: Math.random() * canvas.width, y: Math.random() * canvas.height,
        r: Math.random() * 1.3 + 0.4, c: colors[Math.floor(Math.random() * colors.length)],
        v: Math.random() * 0.06 + 0.01, a: Math.random() * Math.PI * 2,
      }));
    };
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of stars) {
        const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 4);
        g.addColorStop(0, s.c);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    const onResize = () => { resize(); draw(); };
    resize();
    draw();
    window.addEventListener('resize', onResize);
    if (still) return () => window.removeEventListener('resize', onResize);

    let frame = 0;
    const tick = () => {
      for (const s of stars) {
        s.x += Math.cos(s.a) * s.v;
        s.y += Math.sin(s.a) * s.v;
        s.a += 0.001;
        if (s.x < -10 || s.x > canvas.width + 10 || s.y < -10 || s.y > canvas.height + 10) {
          s.x = Math.random() * canvas.width;
          s.y = Math.random() * canvas.height;
        }
      }
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', onResize); };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 h-full w-full"
      style={{ background: 'linear-gradient(to bottom right, #0f172a, #1e1b4b)' }}
    />
  );
}
