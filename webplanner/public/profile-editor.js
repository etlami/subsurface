//
// Interactive dive-profile editor on an HTML canvas.
//
// The user draws a dive plan as a series of waypoints (time, depth, cyl). The
// x-axis is runtime in minutes, the y-axis is depth in metres with 0 at the top
// (like the Subsurface desktop profile). This mirrors the drag-handle UX of the
// desktop planner (core widget: profile-widget/divehandler.cpp), but in the
// browser:
//   - click on empty space  -> add a waypoint (inherits the previous gas)
//   - click a handle         -> select it (gas shown/editable in the panel)
//   - drag a handle          -> move a waypoint (live)
//   - right-click / dblclick -> delete a waypoint
// Each waypoint carries a cylinder index (cyl); handles are coloured by gas.
// A computed profile and the deco ceiling can be overlaid on top.

const HANDLE_R = 7;
const PAD = { left: 54, right: 16, top: 16, bottom: 34 };

export class ProfileEditor {
	constructor(canvas, onChange) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d');
		this.onChange = onChange;
		this.onSelect = null;

		// Editable plan waypoints: {time: seconds, depth: mm, cyl: index}.
		// Always sorted by time. The implicit start is the surface at t=0.
		this.waypoints = [
			{ time: 120, depth: 30000, cyl: 0 },
			{ time: 20 * 60, depth: 30000, cyl: 0 },
		];

		this.computed = null;     // {samples:[...]} set via setComputed()
		this.gasColors = [];      // per-cylinder colour, set via setGasColors()
		this.selectedIdx = -1;

		this.maxTime = 30 * 60;
		this.maxDepth = 40000;
		this.dragIdx = -1;
		this.snap = true;

		this._bind();
		this.resize();
	}

	_bind() {
		const c = this.canvas;
		c.addEventListener('pointerdown', (e) => this._onDown(e));
		c.addEventListener('pointermove', (e) => this._onMove(e));
		window.addEventListener('pointerup', (e) => this._onUp(e));
		c.addEventListener('dblclick', (e) => this._onDblClick(e));
		c.addEventListener('contextmenu', (e) => { e.preventDefault(); this._deleteNear(e); });
		window.addEventListener('resize', () => this.resize());
	}

	resize() {
		const rect = this.canvas.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		this.canvas.width = Math.round(rect.width * dpr);
		this.canvas.height = Math.round(rect.height * dpr);
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.W = rect.width;
		this.H = rect.height;
		this.render();
	}

	setSnap(on) { this.snap = on; this.render(); }
	setComputed(result) { this.computed = result; this.render(); }
	setGasColors(colors) { this.gasColors = colors || []; this.render(); }
	getWaypoints() { return this.waypoints.map((w) => ({ ...w })); }
	getSelected() { return this.selectedIdx >= 0 ? { ...this.waypoints[this.selectedIdx], idx: this.selectedIdx } : null; }

	// Replace the whole plan (e.g. when restoring from a shared URL).
	setWaypoints(list, notify = true) {
		this.waypoints = (list && list.length ? list : this.waypoints).map((w) => ({
			time: w.time, depth: w.depth, cyl: w.cyl || 0,
		}));
		this._sort();
		this.selectedIdx = -1;
		if (notify) this._changed(); else this.render();
	}

	// Clamp a cylinder index that no longer exists (after removing a gas).
	clampGasIndices(numCyl) {
		let changed = false;
		for (const w of this.waypoints) if (w.cyl >= numCyl) { w.cyl = 0; changed = true; }
		if (changed) this._changed(); else this.render();
	}

	setSelectedGas(cyl) {
		if (this.selectedIdx < 0) return;
		this.waypoints[this.selectedIdx].cyl = cyl;
		this._changed();
	}

	// --- coordinate transforms -------------------------------------------------
	_plotW() { return this.W - PAD.left - PAD.right; }
	_plotH() { return this.H - PAD.top - PAD.bottom; }
	_x(timeS) { return PAD.left + (timeS / this.maxTime) * this._plotW(); }
	_y(depthMm) { return PAD.top + (depthMm / this.maxDepth) * this._plotH(); }
	_timeAt(px) { return ((px - PAD.left) / this._plotW()) * this.maxTime; }
	_depthAt(py) { return ((py - PAD.top) / this._plotH()) * this.maxDepth; }

	_evtPos(e) {
		const r = this.canvas.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	_rescale() {
		let mt = 10 * 60, md = 10000;
		for (const w of this.waypoints) { mt = Math.max(mt, w.time); md = Math.max(md, w.depth); }
		if (this.computed) {
			const s = this.computed.samples;
			for (let i = 0; i < s.length; i++) { mt = Math.max(mt, s[i].time_s); md = Math.max(md, s[i].depth_mm); }
		}
		this.maxTime = Math.ceil((mt * 1.05) / 300) * 300;
		this.maxDepth = Math.ceil((md * 1.1) / 3000) * 3000;
	}

	// --- interaction -----------------------------------------------------------
	_hitHandle(pos) {
		for (let i = 0; i < this.waypoints.length; i++) {
			const hx = this._x(this.waypoints[i].time), hy = this._y(this.waypoints[i].depth);
			if (Math.hypot(pos.x - hx, pos.y - hy) <= HANDLE_R + 4) return i;
		}
		return -1;
	}

	_select(idx) {
		this.selectedIdx = idx;
		this.onSelect?.(this.getSelected());
	}

	_onDown(e) {
		const pos = this._evtPos(e);
		const idx = this._hitHandle(pos);
		if (idx >= 0) {
			this.dragIdx = idx;
			this._select(idx);
			this.canvas.setPointerCapture?.(e.pointerId);
			this.render();
		} else if (e.button === 0 && pos.x > PAD.left && pos.y > PAD.top) {
			const w = this._clampSnap(this._timeAt(pos.x), this._depthAt(pos.y));
			w.cyl = this._inheritGas(w.time);
			this.waypoints.push(w);
			this._sort();
			this.dragIdx = this.waypoints.indexOf(w);
			this._select(this.dragIdx);
			this._changed();
		}
	}

	// New points breathe the gas of the latest earlier waypoint.
	_inheritGas(timeS) {
		let cyl = 0, best = -1;
		for (const w of this.waypoints) if (w.time <= timeS && w.time > best) { best = w.time; cyl = w.cyl; }
		return cyl;
	}

	_onMove(e) {
		if (this.dragIdx < 0) {
			const idx = this._hitHandle(this._evtPos(e));
			this.canvas.style.cursor = idx >= 0 ? 'grab' : 'crosshair';
			return;
		}
		const pos = this._evtPos(e);
		const cyl = this.waypoints[this.dragIdx].cyl;
		const w = this._clampSnap(this._timeAt(pos.x), this._depthAt(pos.y));
		w.cyl = cyl;
		this.waypoints[this.dragIdx] = w;
		this._sort();
		this.dragIdx = this.waypoints.indexOf(w);
		this._select(this.dragIdx);
		this.canvas.style.cursor = 'grabbing';
		this._changed();
	}

	_onUp() { this.dragIdx = -1; }
	_onDblClick(e) { this._deleteNear(e); }

	_deleteNear(e) {
		const idx = this._hitHandle(this._evtPos(e));
		if (idx >= 0 && this.waypoints.length > 1) {
			this.waypoints.splice(idx, 1);
			this.selectedIdx = -1;
			this.onSelect?.(null);
			this._changed();
		}
	}

	_clampSnap(timeS, depthMm) {
		timeS = Math.max(0, timeS);
		depthMm = Math.max(0, depthMm);
		if (this.snap) {
			timeS = Math.round(timeS / 60) * 60;
			depthMm = Math.round(depthMm / 3000) * 3000;
		}
		return { time: timeS, depth: depthMm, cyl: 0 };
	}

	_sort() { this.waypoints.sort((a, b) => a.time - b.time || a.depth - b.depth); }

	_changed() { this.render(); this.onChange?.(this.getWaypoints()); }

	// --- rendering -------------------------------------------------------------
	render() {
		this._rescale();
		const ctx = this.ctx;
		ctx.clearRect(0, 0, this.W, this.H);
		this._drawGrid();
		if (this.computed) {
			this._drawCeiling();
			this._drawComputed();
		}
		this._drawPlan();
	}

	_drawGrid() {
		const ctx = this.ctx;
		ctx.font = '11px system-ui, sans-serif';
		ctx.lineWidth = 1;
		const depthStep = this.maxDepth <= 18000 ? 3000 : this.maxDepth <= 45000 ? 6000 : 10000;
		ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
		for (let d = 0; d <= this.maxDepth; d += depthStep) {
			const y = this._y(d);
			ctx.strokeStyle = d === 0 ? '#9bb' : '#e4eef2';
			ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(this.W - PAD.right, y); ctx.stroke();
			ctx.fillStyle = '#567';
			ctx.fillText(`${(d / 1000).toFixed(0)}m`, PAD.left - 6, y);
		}
		const timeStep = this.maxTime <= 1800 ? 300 : this.maxTime <= 3600 ? 600 : 1200;
		ctx.textAlign = 'center'; ctx.textBaseline = 'top';
		for (let t = 0; t <= this.maxTime; t += timeStep) {
			const x = this._x(t);
			ctx.strokeStyle = '#eef4f6';
			ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, this.H - PAD.bottom); ctx.stroke();
			ctx.fillStyle = '#567';
			ctx.fillText(`${Math.round(t / 60)}`, x, this.H - PAD.bottom + 6);
		}
		ctx.textAlign = 'center';
		ctx.fillStyle = '#789';
		ctx.fillText('Zeit (min)', PAD.left + this._plotW() / 2, this.H - 14);
	}

	_drawComputed() {
		const s = this.computed.samples;
		if (!s.length) return;
		const ctx = this.ctx;
		ctx.beginPath();
		ctx.moveTo(this._x(0), this._y(0));
		for (let i = 0; i < s.length; i++) ctx.lineTo(this._x(s[i].time_s), this._y(s[i].depth_mm));
		ctx.strokeStyle = '#1b6ec2';
		ctx.lineWidth = 2;
		ctx.stroke();
		ctx.lineTo(this._x(s[s.length - 1].time_s), this._y(0));
		ctx.closePath();
		ctx.fillStyle = 'rgba(27,110,194,0.08)';
		ctx.fill();
	}

	_drawCeiling() {
		const s = this.computed.samples;
		let any = false;
		const ctx = this.ctx;
		ctx.beginPath();
		for (let i = 0; i < s.length; i++) {
			const c = s[i].stopdepth_mm || 0;
			const x = this._x(s[i].time_s), y = this._y(c);
			if (!any) { ctx.moveTo(x, y); any = true; } else { ctx.lineTo(x, y); }
		}
		if (any) {
			ctx.strokeStyle = 'rgba(214,69,65,0.9)';
			ctx.lineWidth = 1.5;
			ctx.setLineDash([4, 3]);
			ctx.stroke();
			ctx.setLineDash([]);
		}
	}

	_gasColor(cyl) { return this.gasColors[cyl] || '#222'; }

	_drawPlan() {
		const ctx = this.ctx;
		ctx.beginPath();
		ctx.moveTo(this._x(0), this._y(0));
		for (const w of this.waypoints) ctx.lineTo(this._x(w.time), this._y(w.depth));
		ctx.strokeStyle = '#33424d';
		ctx.lineWidth = 2;
		ctx.stroke();
		for (let i = 0; i < this.waypoints.length; i++) {
			const w = this.waypoints[i];
			const x = this._x(w.time), y = this._y(w.depth);
			const selected = i === this.selectedIdx;
			if (selected) {
				ctx.beginPath();
				ctx.arc(x, y, HANDLE_R + 4, 0, Math.PI * 2);
				ctx.strokeStyle = '#1b6ec2';
				ctx.lineWidth = 2;
				ctx.stroke();
			}
			ctx.beginPath();
			ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2);
			ctx.fillStyle = this._gasColor(w.cyl);
			ctx.fill();
			ctx.lineWidth = 2;
			ctx.strokeStyle = '#fff';
			ctx.stroke();
		}
	}
}
