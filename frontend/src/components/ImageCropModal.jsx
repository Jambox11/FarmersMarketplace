import React, { useRef, useState, useEffect, useCallback } from 'react';

const HANDLE = 8;

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export default function ImageCropModal({ src, onConfirm, onCancel }) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  // crop box in canvas coords
  const [crop, setCrop] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const drag = useRef(null); // { type: 'move'|'resize', sx, sy, ox, oy, ow, oh }

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !loaded) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // dim outside crop
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    const { x, y, w, h } = crop;
    ctx.fillRect(0, 0, canvas.width, y);
    ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, canvas.width - x - w, h);
    // border
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    // rule-of-thirds
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(x + (w / 3) * i, y); ctx.lineTo(x + (w / 3) * i, y + h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y + (h / 3) * i); ctx.lineTo(x + w, y + (h / 3) * i); ctx.stroke();
    }
    // corner handles
    ctx.fillStyle = '#fff';
    [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([hx, hy]) => {
      ctx.fillRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
    });
  }, [crop, loaded]);

  useEffect(() => { draw(); }, [draw]);

  function initCrop(cw, ch) {
    const size = Math.min(cw, ch) * 0.8;
    setCrop({ x: (cw - size) / 2, y: (ch - size) / 2, w: size, h: size });
  }

  function onImgLoad() {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    // fit inside 480×480
    const maxW = 480, maxH = 480;
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    setLoaded(true);
    initCrop(canvas.width, canvas.height);
  }

  function hitTest(mx, my) {
    const { x, y, w, h } = crop;
    const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
    for (const [cx, cy] of corners) {
      if (Math.abs(mx - cx) <= HANDLE && Math.abs(my - cy) <= HANDLE) return 'resize';
    }
    if (mx >= x && mx <= x + w && my >= y && my <= y + h) return 'move';
    return null;
  }

  function getPos(e) {
    const r = canvasRef.current.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return { mx: src.clientX - r.left, my: src.clientY - r.top };
  }

  function onDown(e) {
    e.preventDefault();
    const { mx, my } = getPos(e);
    const type = hitTest(mx, my);
    if (!type) return;
    drag.current = { type, sx: mx, sy: my, ox: crop.x, oy: crop.y, ow: crop.w, oh: crop.h };
  }

  function onMove(e) {
    if (!drag.current) return;
    e.preventDefault();
    const { mx, my } = getPos(e);
    const { type, sx, sy, ox, oy, ow, oh } = drag.current;
    const cw = canvasRef.current.width, ch = canvasRef.current.height;
    const dx = mx - sx, dy = my - sy;
    if (type === 'move') {
      setCrop(c => ({
        ...c,
        x: clamp(ox + dx, 0, cw - c.w),
        y: clamp(oy + dy, 0, ch - c.h),
      }));
    } else {
      const nw = clamp(ow + dx, 20, cw - ox);
      const nh = clamp(oh + dy, 20, ch - oy);
      setCrop(c => ({ ...c, w: nw, h: nh }));
    }
  }

  function onUp() { drag.current = null; }

  function handleConfirm() {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    const scaleX = img.naturalWidth / canvas.width;
    const scaleY = img.naturalHeight / canvas.height;
    const out = document.createElement('canvas');
    out.width = Math.round(crop.w * scaleX);
    out.height = Math.round(crop.h * scaleY);
    out.getContext('2d').drawImage(
      img,
      crop.x * scaleX, crop.y * scaleY, crop.w * scaleX, crop.h * scaleY,
      0, 0, out.width, out.height,
    );
    out.toBlob(blob => onConfirm(blob), 'image/jpeg', 0.92);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: 24, maxWidth: 540, width: '95%', boxShadow: '0 8px 32px #0004' }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: '#2d6a4f', marginBottom: 12 }}>✂️ Crop Image</div>
        <div style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>Drag the box to move · drag a corner to resize</div>
        <div style={{ overflowX: 'auto', marginBottom: 16 }}>
          <canvas
            ref={canvasRef}
            style={{ display: 'block', cursor: 'crosshair', touchAction: 'none', maxWidth: '100%' }}
            onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
            onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}
          />
        </div>
        {/* hidden img used as draw source */}
        <img ref={imgRef} src={src} onLoad={onImgLoad} style={{ display: 'none' }} alt="" />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
          <button onClick={handleConfirm} disabled={!loaded} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#2d6a4f', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>Use Crop</button>
        </div>
      </div>
    </div>
  );
}
