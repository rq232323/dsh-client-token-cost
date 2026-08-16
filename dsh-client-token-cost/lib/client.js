window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-token-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		// ── 纯格式化函数 ───────────────────────────────────────────────────
		function fmtTokens(n) {
			if (n < 1000) return String(n);
			if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + "K";
			return (n / 1e6).toFixed(2) + "M";
		}
		function fmtCost(yuan) {
			if (yuan === 0) return "0.00";
			if (yuan < 0.01) return yuan.toFixed(4);
			if (yuan < 1) return yuan.toFixed(3);
			return yuan.toFixed(2);
		}

		// ── 本地持久化（位置 / 透明度）─────────────────────────────────────
		const POS_KEY = "dsh-token-cost-pos";
		const OPACITY_KEY = "dsh-token-cost-opacity";
		function loadJSON(key) {
			try {
				const raw = localStorage.getItem(key);
				return raw === null ? null : JSON.parse(raw);
			} catch { return null; }
		}
		function saveJSON(key, value) {
			try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
		}
		function loadPos() {
			const p = loadJSON(POS_KEY);
			return p !== null && typeof p.left === "number" && typeof p.top === "number" ? p : null;
		}
		function loadOpacity() {
			const v = loadJSON(OPACITY_KEY);
			const n = Number(v);
			return Number.isFinite(n) && n >= 0.2 && n <= 1 ? n : 1;
		}
		function clamp(v, min, max) {
			return Math.min(Math.max(v, min), max);
		}

		// ── 峰谷判断（与 host 相同的窗口逻辑，客户端仅用于展示当前时段）──
		function periodAt(windowCfg, date) {
			if (!windowCfg || windowCfg.enabled === false) return "peak";
			const toMin = (s) => {
				const [h, m] = String(s).split(":").map(Number);
				return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
			};
			const fmt = new Intl.DateTimeFormat("en-US", { timeZone: windowCfg.timezone, hour: "2-digit", minute: "2-digit", hour12: false });
			let h = 0;
			let m = 0;
			for (const part of fmt.formatToParts(date)) {
				if (part.type === "hour") h = Number(part.value) === 24 ? 0 : Number(part.value);
				else if (part.type === "minute") m = Number(part.value);
			}
			const t = h * 60 + m;
			for (const seg of (windowCfg.segments ?? [])) {
				const start = toMin(seg.start);
				const end = toMin(seg.end);
				if (start <= end ? t >= start && t < end : t >= start || t < end) return "peak";
			}
			return "offPeak";
		}
		function fmtSegments(segments) {
			return (segments ?? []).map((s) => s.start + "–" + s.end).join(", ");
		}
		function fmtClock(ts) {
			if (typeof ts !== "number") return "";
			const d = new Date(ts);
			const p = (n) => String(n).padStart(2, "0");
			return p(d.getHours()) + ":" + p(d.getMinutes());
		}

		// ── 样式 ───────────────────────────────────────────────────────────
		const css = ".tco_root{position:fixed;z-index:1000;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);border-radius:12px;padding:8px 12px;font-family:inherit;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;display:flex;flex-direction:column;gap:2px;min-width:200px}.tco_title{pointer-events:auto;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:grab;user-select:none;touch-action:none}.tco_title:active{cursor:grabbing}.tco_title:hover{color:var(--dsw-alias-label-primary)}.tco_cost{font-size:15px;font-weight:600;line-height:22px}.tco_cost .tco_cur{color:var(--dsw-alias-label-secondary);font-weight:400;font-size:12px;margin-right:4px}.tco_row{display:flex;justify-content:space-between;gap:12px}.tco_row dt{color:var(--dsw-alias-label-tertiary)}.tco_row dd{margin:0;color:var(--dsw-alias-label-secondary)}.tco_model{display:flex;flex-direction:column;gap:1px;padding-top:4px}.tco_modelHead{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.tco_modelName{color:var(--dsw-alias-label-secondary);font-weight:500;font-size:12px}.tco_modelCost{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}.tco_modelMeta{color:var(--dsw-alias-label-caption);font-size:10px;line-height:14px}.tco_divider{border-top:1px solid var(--dsw-alias-border-l2);margin:2px 0}.tco_total{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.tco_total dt{color:var(--dsw-alias-label-secondary);font-weight:600}.tco_total dd{margin:0;color:var(--dsw-alias-label-primary);font-weight:600}.tco_note{color:var(--dsw-alias-label-caption);font-size:10px;line-height:14px}.tco_panel{pointer-events:auto;position:fixed;z-index:1002;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv3);border-radius:12px;padding:12px 14px;width:280px;display:flex;flex-direction:column;gap:10px;max-height:calc(100vh - 24px);overflow-y:auto}.tco_panelTitle{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}.tco_group{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px}.tco_groupTitle{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary)}.tco_field{display:flex;flex-direction:column;gap:4px}.tco_fieldLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}.tco_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:30px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:13px;line-height:1.5}.tco_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.tco_slider{width:100%;accent-color:var(--dsw-alias-brand-primary)}.tco_actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}.tco_btn{font:inherit;font-size:12px;line-height:18px;cursor:pointer;border-radius:8px;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}.tco_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}.tco_btnPrimary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}.tco_btnPrimary:hover{opacity:.9}.tco_hint{font-size:10px;line-height:14px;color:var(--dsw-alias-label-caption)}.tco_rateGroup{display:flex;flex-direction:column;gap:4px;margin-top:2px}.tco_rateTitle{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-weight:600}.tco_groupHead{display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer;user-select:none}.tco_chevron{color:var(--dsw-alias-label-tertiary);font-size:10px}.tco_rateHead{display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer;user-select:none;padding-top:2px}.tco_panelTitleRow{display:flex;justify-content:space-between;align-items:center;gap:8px}.tco_masterToggle{font-size:11px;line-height:16px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:2px 8px}.tco_masterToggle:hover{background:var(--dsw-alias-interactive-bg-hover)}.tco_error{color:var(--dsw-alias-danger,#e5484d);font-size:11px;line-height:16px}.tco_checkRow{display:flex;align-items:center;gap:6px}.tco_checkRow input{accent-color:var(--dsw-alias-brand-primary)}.tco_timeRow{display:flex;gap:8px}.tco_timeRow .tco_field{flex:1}.tco_groupBody{display:flex;flex-direction:column;gap:2px}.tco_btnSmall{padding:2px 8px;font-size:11px;line-height:16px;align-self:flex-start}";
		const tagId = "@deepseek-ai/dsh-client-token-cost/token-cost.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-token-cost";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ── 设置面板 ───────────────────────────────────────────────────────
		// models: [{ model, label, currency, peak, offPeak }]
		// 价格与高峰时段保存到 host settings（settings.yaml），全浏览器生效。
		function RateFields({ periodLabel, values, onChange, open, onToggle }) {
			const field = (label, key) => react_jsx_runtime.jsxs("div", {
				className: "tco_field",
				children: [
					react_jsx_runtime.jsx("label", { className: "tco_fieldLabel", children: label }),
					react_jsx_runtime.jsx("input", { className: "tco_input", type: "text", inputMode: "decimal", value: values[key], onChange: (e) => onChange(key, e.target.value) })
				]
			});
			return react_jsx_runtime.jsxs("div", {
				className: "tco_rateGroup",
				children: [
					react_jsx_runtime.jsx("div", {
						className: "tco_rateHead",
						onClick: onToggle,
						children: [
							react_jsx_runtime.jsx("span", { className: "tco_rateTitle", children: periodLabel }),
							react_jsx_runtime.jsx("span", { className: "tco_chevron", children: open ? "▾" : "▸" })
						]
					}),
					open && react_jsx_runtime.jsxs("div", {
						className: "tco_rateFields",
						children: [
							field("缓存命中输入（元 / 百万 token）", "hit"),
							field("缓存未命中输入（元 / 百万 token）", "miss"),
							field("输出（元 / 百万 token）", "out")
						]
					})
				]
			});
		}
		function SettingsPanel({ models, peakWindow, onSave, onReset, onClose, saving, error }) {
			const [drafts, setDrafts] = react.useState(() => {
				const d = {};
				for (const m of models) {
					d[m.model] = {
						peak: { hit: String(m.peak.hitInput), miss: String(m.peak.missInput), out: String(m.peak.output) },
						offPeak: { hit: String(m.offPeak.hitInput), miss: String(m.offPeak.missInput), out: String(m.offPeak.output) }
					};
				}
				return d;
			});
			const [win, setWin] = react.useState({
				enabled: peakWindow.enabled,
				segments: (peakWindow.segments ?? []).map((s) => ({ start: s.start, end: s.end })),
				timezone: peakWindow.timezone
			});
			const setSegment = (index, field, value) => {
				setWin((prev) => {
					const segments = prev.segments.map((s, i) => (i === index ? { ...s, [field]: value } : s));
					return { ...prev, segments };
				});
			};
			const addSegment = () => {
				setWin((prev) => ({ ...prev, segments: [...prev.segments, { start: "09:00", end: "12:00" }] }));
			};
			const removeSegment = (index) => {
				setWin((prev) => ({ ...prev, segments: prev.segments.filter((_, i) => i !== index) }));
			};
			// 折叠状态：模型组默认只展开第一个；价目子组默认展开。
			const [openModels, setOpenModels] = react.useState(() => {
				const o = {};
				if (models.length > 0) o[models[0].model] = true;
				return o;
			});
			const [openRates, setOpenRates] = react.useState({});
			const [opacity, setOpacity] = react.useState(loadOpacity);
			const [initialOpacity] = react.useState(loadOpacity);
			const allOpen = models.length > 0 && models.every((m) => openModels[m.model] === true);
			const rateOpen = (key) => openRates[key] !== false;
			const setField = (model, period, field, value) => {
				setDrafts((prev) => ({ ...prev, [model]: { ...prev[model], [period]: { ...prev[model][period], [field]: value } } }));
			};
			const rateDirty = (m, period, d) => {
				const base = m[period];
				return d[period].hit !== String(base.hitInput) || d[period].miss !== String(base.missInput) || d[period].out !== String(base.output);
			};
			const winDirty = win.enabled !== peakWindow.enabled
				|| win.timezone !== peakWindow.timezone
				|| JSON.stringify(win.segments) !== JSON.stringify(peakWindow.segments ?? []);
			const dirty = models.some((m) => {
				const d = drafts[m.model];
				return rateDirty(m, "peak", d) || rateDirty(m, "offPeak", d);
			}) || winDirty || opacity !== initialOpacity;
			const parseAll = () => {
				const out = {};
				for (const m of models) {
					const d = drafts[m.model];
					const rate = (period) => {
						const h = Number(d[period].hit);
						const mi = Number(d[period].miss);
						const o = Number(d[period].out);
						if (![h, mi, o].every((n) => Number.isFinite(n) && n >= 0)) return null;
						return { hitInput: h, missInput: mi, output: o };
					};
					const peak = rate("peak");
					const offPeak = rate("offPeak");
					if (peak === null || offPeak === null) return null;
					out[m.model] = { peak, offPeak };
				}
				const segments = win.segments.map((s) => ({
					start: String(s.start).trim(),
					end: String(s.end).trim()
				}));
				for (const seg of segments) {
					if (!/^\d{1,2}:\d{2}$/.test(seg.start) || !/^\d{1,2}:\d{2}$/.test(seg.end)) return null;
				}
				const w = {
					enabled: win.enabled,
					segments,
					timezone: String(win.timezone).trim() || "Asia/Shanghai"
				};
				return { models: out, peakWindow: w };
			};
			return react_jsx_runtime.jsxs("div", {
				className: "tco_panel",
				onPointerDown: (e) => e.stopPropagation(),
				onClick: (e) => e.stopPropagation(),
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "tco_panelTitleRow",
						children: [
							react_jsx_runtime.jsx("div", { className: "tco_panelTitle", children: "Token 花费设置" }),
							react_jsx_runtime.jsx("button", {
								className: "tco_masterToggle",
								onClick: () => setOpenModels(allOpen ? {} : Object.fromEntries(models.map((m) => [m.model, true]))),
								children: allOpen ? "收起全部" : "展开全部"
							})
						]
					}),
					models.map((m) => {
						const d = drafts[m.model];
						const open = openModels[m.model] === true;
						return react_jsx_runtime.jsxs("div", {
							className: "tco_group",
							key: m.model,
							children: [
								react_jsx_runtime.jsx("div", {
									className: "tco_groupHead",
									onClick: () => setOpenModels((prev) => ({ ...prev, [m.model]: !(prev[m.model] === true) })),
									children: [
										react_jsx_runtime.jsx("div", { className: "tco_groupTitle", children: m.label }),
										react_jsx_runtime.jsx("span", { className: "tco_chevron", children: open ? "▾" : "▸" })
									]
								}),
								open && react_jsx_runtime.jsxs("div", {
									className: "tco_groupBody",
									children: [
										react_jsx_runtime.jsx(RateFields, {
											periodLabel: "高峰价",
											values: d.peak,
											open: rateOpen(m.model + ".peak"),
											onToggle: () => setOpenRates((prev) => ({ ...prev, [m.model + ".peak"]: !(prev[m.model + ".peak"] !== false) })),
											onChange: (f, v) => setField(m.model, "peak", f, v)
										}),
										react_jsx_runtime.jsx(RateFields, {
											periodLabel: "闲时价",
											values: d.offPeak,
											open: rateOpen(m.model + ".offPeak"),
											onToggle: () => setOpenRates((prev) => ({ ...prev, [m.model + ".offPeak"]: !(prev[m.model + ".offPeak"] !== false) })),
											onChange: (f, v) => setField(m.model, "offPeak", f, v)
										})
									]
								})
							]
						});
					}),
					react_jsx_runtime.jsxs("div", {
						className: "tco_group",
						children: [
							react_jsx_runtime.jsx("div", { className: "tco_groupTitle", children: "高峰时段" }),
							react_jsx_runtime.jsxs("div", {
								className: "tco_checkRow",
								children: [
									react_jsx_runtime.jsx("input", { type: "checkbox", checked: win.enabled, onChange: (e) => setWin((prev) => ({ ...prev, enabled: e.target.checked })) }),
									react_jsx_runtime.jsx("label", { className: "tco_fieldLabel", children: "启用峰谷计价（关闭则全部按高峰价计）" })
								]
							}),
							react_jsx_runtime.jsx("div", { className: "tco_fieldLabel", children: "高峰时段（可多段，其余为闲时）" }),
							win.segments.map((seg, idx) => react_jsx_runtime.jsxs("div", {
								className: "tco_timeRow",
								key: idx,
								children: [
									react_jsx_runtime.jsxs("div", {
										className: "tco_field",
										children: [
											react_jsx_runtime.jsx("label", { className: "tco_fieldLabel", children: "开始" }),
											react_jsx_runtime.jsx("input", { className: "tco_input", type: "text", value: seg.start, onChange: (e) => setSegment(idx, "start", e.target.value) })
										]
									}),
									react_jsx_runtime.jsxs("div", {
										className: "tco_field",
										children: [
											react_jsx_runtime.jsx("label", { className: "tco_fieldLabel", children: "结束" }),
											react_jsx_runtime.jsx("input", { className: "tco_input", type: "text", value: seg.end, onChange: (e) => setSegment(idx, "end", e.target.value) })
										]
									}),
									react_jsx_runtime.jsx("button", {
										className: "tco_btn tco_btnSmall",
										disabled: win.segments.length <= 1,
										onClick: () => removeSegment(idx),
										children: "删"
									})
								]
							})),
							react_jsx_runtime.jsx("button", { className: "tco_btn tco_btnSmall", onClick: addSegment, children: "+ 添加时段" }),
							react_jsx_runtime.jsxs("div", {
								className: "tco_field",
								children: [
									react_jsx_runtime.jsx("label", { className: "tco_fieldLabel", children: "时区（IANA，如 Asia/Shanghai）" }),
									react_jsx_runtime.jsx("input", { className: "tco_input", type: "text", value: win.timezone, onChange: (e) => setWin((prev) => ({ ...prev, timezone: e.target.value })) })
								]
							})
						]
					}),
					react_jsx_runtime.jsxs("div", {
						className: "tco_field",
						children: [
							react_jsx_runtime.jsx("label", { className: "tco_fieldLabel", children: "透明度 " + Math.round(opacity * 100) + "%" }),
							react_jsx_runtime.jsx("input", { className: "tco_slider", type: "range", min: 0.2, max: 1, step: 0.05, value: opacity, onChange: (e) => setOpacity(Number(e.target.value)) })
						]
					}),
					error !== null && react_jsx_runtime.jsx("div", { className: "tco_error", children: error }),
					react_jsx_runtime.jsxs("div", {
						className: "tco_actions",
						children: [
							react_jsx_runtime.jsx("button", { className: "tco_btn", onClick: onReset, disabled: saving, children: "恢复默认" }),
							react_jsx_runtime.jsx("button", { className: "tco_btn", onClick: onClose, disabled: saving, children: "取消" }),
							react_jsx_runtime.jsx("button", {
								className: "tco_btn tco_btnPrimary",
								disabled: !dirty || saving,
								onClick: () => {
									const p = parseAll();
									if (p === null) return;
									onSave(p, opacity);
								},
								children: saving ? "保存中…" : "保存"
							})
						]
					}),
					react_jsx_runtime.jsx("div", {
						className: "tco_hint",
						children: "价格与高峰时段保存到 settings.yaml（全浏览器生效，重启不丢）；透明度仅本浏览器。"
					})
				]
			});
		}

		// ── 组件 ───────────────────────────────────────────────────────────
		function TokenCostWidget({ useSessions }) {
			const cost = useSessions((s) => {
				const current = s.byId[s.current];
				return current ? current.projectionValues?.tokenCost : void 0;
			});
			const [pos, setPos] = react.useState(() => loadPos());
			const [opacity, setOpacity] = react.useState(() => loadOpacity());
			const [panelOpen, setPanelOpen] = react.useState(false);
			const [panelPos, setPanelPos] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [saveError, setSaveError] = react.useState(null);
			const dragRef = react.useRef(null);

			const onPointerDown = react.useCallback((e) => {
				if (e.button !== 0 && e.pointerType === "mouse") return;
				const root = dragRef.current;
				if (root === null) return;
				const rect = root.getBoundingClientRect();
				const startLeft = rect.left;
				const startTop = rect.top;
				const startX = e.clientX;
				const startY = e.clientY;
				const move = (ev) => {
					const vw = window.innerWidth;
					const vh = window.innerHeight;
					setPos({
						left: clamp(startLeft + ev.clientX - startX, 0, vw - rect.width),
						top: clamp(startTop + ev.clientY - startY, 0, vh - rect.height)
					});
				};
				const up = () => {
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", up);
					window.removeEventListener("pointercancel", up);
				};
				window.addEventListener("pointermove", move);
				window.addEventListener("pointerup", up);
				window.addEventListener("pointercancel", up);
				e.preventDefault();
			}, []);

			const onContextMenu = react.useCallback((e) => {
				e.preventDefault();
				const root = dragRef.current;
				const vw = window.innerWidth;
				const vh = window.innerHeight;
				const PW = 300;
				const PH = 420;
				const GAP = 8;
				let px = e.clientX;
				let py = e.clientY;
				if (root !== null) {
					const rect = root.getBoundingClientRect();
					px = rect.left;
					// 优先在上方打开；上方放不下就放到下方；都放不下才重叠
					// （重叠时靠 z-index 保证面板始终在最上层）。
					if (rect.top - GAP >= PH + GAP) py = rect.top - GAP;
					else if (rect.bottom + GAP + PH <= vh) py = rect.bottom + GAP;
					else py = rect.top - GAP;
				}
				px = clamp(px, GAP, Math.max(GAP, vw - PW));
				py = clamp(py, GAP, Math.max(GAP, vh - PH));
				setPanelPos({ left: px, top: py });
				setPanelOpen(true);
			}, []);

			react.useEffect(() => {
				if (pos !== null) saveJSON(POS_KEY, pos);
			}, [pos]);

			react.useEffect(() => {
				if (!panelOpen) return;
				const close = () => setPanelOpen(false);
				window.addEventListener("pointerdown", close);
				return () => window.removeEventListener("pointerdown", close);
			}, [panelOpen]);

			if (cost === void 0) return null;

			// 花费一律以 host 投影为准（价格与峰谷窗口都来自 settings.yaml）。
			const modelRows = cost.models;
			const totalCost = modelRows.reduce((sum, m) => sum + m.cost, 0);
			const periodNow = periodAt(cost.peakWindow, new Date());

			const style = pos === null
				? { left: 12, bottom: 12, opacity }
				: { left: pos.left, top: pos.top, opacity };

			return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
				children: [
					react_jsx_runtime.jsxs("div", {
						ref: dragRef,
						className: "tco_root",
						style: style,
						onContextMenu: onContextMenu,
						children: [
							react_jsx_runtime.jsx("div", {
								className: "tco_title",
								onPointerDown: onPointerDown,
								title: "拖动以移动 · 右键打开设置",
								children: "本会话用量与花费"
							}),
							modelRows.map((m) => react_jsx_runtime.jsxs("div", {
								className: "tco_model",
								key: m.model,
								children: [
									react_jsx_runtime.jsxs("div", {
										className: "tco_modelHead",
										children: [
											react_jsx_runtime.jsx("span", { className: "tco_modelName", children: m.label }),
											react_jsx_runtime.jsxs("span", {
												className: "tco_modelCost",
												children: [m.currency, fmtCost(m.cost)]
											})
										]
									}),
									react_jsx_runtime.jsx("div", {
										className: "tco_modelMeta",
										children: "入 " + fmtTokens(m.missInputTokens + m.hitInputTokens) + " · 出 " + fmtTokens(m.outputTokens)
									})
								]
							})),
							react_jsx_runtime.jsx("div", { className: "tco_divider" }),
							react_jsx_runtime.jsxs("div", {
								className: "tco_total",
								children: [
									react_jsx_runtime.jsx("dt", { children: "合计" }),
									react_jsx_runtime.jsx("dd", { children: "¥ " + fmtCost(totalCost) })
								]
							}),
							react_jsx_runtime.jsx("div", {
								className: "tco_note",
								children: (cost.peakWindow.segments.length > 0
									? "高峰 " + fmtSegments(cost.peakWindow.segments)
									: "无高峰时段")
									+ (cost.peakWindow.enabled ? "" : "（已关闭）")
									+ " · " + (periodNow === "peak" ? "高峰时段" : "闲时时段")
									+ " · 右键设置"
							})
						]
					}),
					panelOpen && panelPos !== null && react_jsx_runtime.jsx("div", {
						style: { position: "fixed", left: panelPos.left, top: panelPos.top, zIndex: 1001 },
						children: react_jsx_runtime.jsx(SettingsPanel, {
							models: cost.models.map((m) => ({ model: m.model, label: m.label, currency: m.currency, peak: m.peak, offPeak: m.offPeak })),
							peakWindow: cost.peakWindow,
							saving: saving,
							error: saveError,
							onSave: async (payload, op) => {
								setSaving(true);
								setSaveError(null);
								try {
									const res = await fetch("/dsh-token-cost/settings", {
										method: "POST",
										headers: { "content-type": "application/json" },
										body: JSON.stringify({ models: payload.models, peakWindow: payload.peakWindow })
									});
									const data = await res.json().catch(() => ({}));
									if (!res.ok || data.error) throw new Error(data.error || ("HTTP " + res.status));
									saveJSON(OPACITY_KEY, op);
									setOpacity(op);
									setPanelOpen(false);
								} catch (err) {
									setSaveError(err.message || String(err));
								} finally {
									setSaving(false);
								}
							},
							onReset: async () => {
								setSaving(true);
								setSaveError(null);
								try {
									const res = await fetch("/dsh-token-cost/settings", {
										method: "POST",
										headers: { "content-type": "application/json" },
										body: JSON.stringify({ reset: true })
									});
									const data = await res.json().catch(() => ({}));
									if (!res.ok || data.error) throw new Error(data.error || ("HTTP " + res.status));
									localStorage.removeItem(OPACITY_KEY);
									setOpacity(1);
									setPanelOpen(false);
								} catch (err) {
									setSaveError(err.message || String(err));
								} finally {
									setSaving(false);
								}
							},
							onClose: () => setPanelOpen(false)
						})
					})
				]
			});
		}

		// ── 注册到 shell.overlay ───────────────────────────────────────────
		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "token-cost-widget",
				order: 0
			}, TokenCostWidget));
		}
		exports.TokenCostWidget = TokenCostWidget;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
