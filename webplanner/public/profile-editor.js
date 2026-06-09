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
		// Bigger touch target on coarse pointers (phones/tablets).
		this.hitPad = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 16 : 4;

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

	// Delete the currently selected waypoint (used by the touch-friendly button).
	deleteSelected() {
		if (this.selectedIdx < 0 || this.waypoints.length <= 1) return;
		this.waypoints.splice(this.selectedIdx, 1);
		this.selectedIdx = -1;
		this.onSelect?.(null);
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
			if (Math.hypot(pos.x - hx, pos.y - hy) <= HANDLE_R + this.hitPad) return i;
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
			this._drawSetpointLine();
			this._drawDecoStops();
			this._drawSetpointMarkers();
			this._drawGasSwitches();
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

	// Decompression ceiling: the depth you must not ascend above. Drawn as a red
	// band from the surface down to the ceiling (the forbidden zone), plus a red
	// line along the ceiling itself — visible only while a ceiling exists.
	_drawCeiling() {
		const s = this.computed.samples;
		const cm = (i) => (s[i] && s[i].ceiling_mm) || 0;
		let hasCeil = false;
		for (let i = 0; i < s.length; i++) if (cm(i) > 0) { hasCeil = true; break; }
		if (!hasCeil) return;
		const ctx = this.ctx;
		// filled forbidden zone (surface .. ceiling)
		ctx.beginPath();
		ctx.moveTo(this._x(s[0].time_s), this._y(0));
		for (let i = 0; i < s.length; i++) ctx.lineTo(this._x(s[i].time_s), this._y(cm(i)));
		for (let i = s.length - 1; i >= 0; i--) ctx.lineTo(this._x(s[i].time_s), this._y(0));
		ctx.closePath();
		ctx.fillStyle = 'rgba(214,69,65,0.16)';
		ctx.fill();
		// ceiling line where it exists
		ctx.strokeStyle = 'rgba(214,69,65,0.95)';
		ctx.lineWidth = 1.8;
		ctx.setLineDash([5, 3]);
		let pen = false;
		ctx.beginPath();
		for (let i = 0; i < s.length; i++) {
			const c = cm(i);
			const x = this._x(s[i].time_s), y = this._y(c);
			if (c > 0) { if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y); }
			else pen = false;
		}
		ctx.stroke();
		ctx.setLineDash([]);
	}

	_depthAtTime(timeS) {
		const s = this.computed && this.computed.samples;
		if (!s || !s.length) return 0;
		for (let i = 0; i < s.length; i++) if (s[i].time_s >= timeS) return s[i].depth_mm;
		return s[s.length - 1].depth_mm;
	}

	// Constant-depth deco stops, labelled with depth + duration.
	_drawDecoStops() {
		const stops = this.computed.stops;
		if (!stops || !stops.length) return;
		const ctx = this.ctx;
		ctx.font = 'bold 11px system-ui, sans-serif';
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';
		for (const st of stops) {
			const x = this._x(st.time_s), y = this._y(st.depth_mm);
			ctx.fillStyle = '#d64541';
			ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
			const label = `${(st.depth_mm / 1000).toFixed(0)} m / ${st.min}′`;
			ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.9)';
			ctx.strokeText(label, x + 6, y);
			ctx.fillStyle = '#9a3b38';
			ctx.fillText(label, x + 6, y);
		}
	}

	// CCR setpoint switch depth (horizontal guide line).
	_drawSetpointLine() {
		const d = this.computed.setpointDepthMm;
		if (!d) return;
		const ctx = this.ctx;
		const y = this._y(d);
		ctx.strokeStyle = 'rgba(122,63,176,0.55)';
		ctx.lineWidth = 1;
		ctx.setLineDash([2, 4]);
		ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(this.W - PAD.right, y); ctx.stroke();
		ctx.setLineDash([]);
		ctx.fillStyle = '#7a3fb0';
		ctx.font = '10px system-ui, sans-serif';
		ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
		ctx.fillText('SP-Wechsel', PAD.left + 4, y - 1);
	}

	// CCR setpoint-change markers where the profile crosses the switch depth.
	_drawSetpointMarkers() {
		const sp = this.computed.spMarkers;
		if (!sp || !sp.length) return;
		const ctx = this.ctx;
		ctx.font = 'bold 10px system-ui, sans-serif';
		for (const m of sp) {
			const x = this._x(m.time_s), y = this._y(m.depth_mm);
			ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8); ctx.strokeStyle = '#7a3fb0'; ctx.lineWidth = 1.5; ctx.stroke();
			ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = '#7a3fb0'; ctx.fill();
			ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
			ctx.fillStyle = '#5a2d86'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
			ctx.fillText(m.label, x - 6, y - 4);
		}
	}

	// Gas-change markers on the computed profile.
	_drawGasSwitches() {
		const sw = this.computed.switches;
		if (!sw || !sw.length) return;
		const ctx = this.ctx;
		ctx.font = 'bold 10px system-ui, sans-serif';
		for (const g of sw) {
			const x = this._x(g.time_s), y = this._y(this._depthAtTime(g.time_s));
			ctx.strokeStyle = g.color || '#222';
			ctx.lineWidth = 1.5;
			ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9); ctx.stroke();
			ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
			ctx.fillStyle = g.color || '#222'; ctx.fill();
			ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
			ctx.fillStyle = '#222';
			ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
			ctx.fillText(g.label || '', x + 6, y - 6);
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
