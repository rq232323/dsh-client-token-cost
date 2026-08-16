//#region lib/index.js
/**
 * Host half of the token-cost plugin, v2: peak/off-peak pricing + auto-fetch.
 *
 * Pricing model
 * ------------
 * Every model now has TWO rate cards (RMB per 1,000,000 tokens):
 *   - `peak`   : the rate applied while the request time falls inside the
 *                configured peak window (DeepSeek's 峰谷定价 effective
 *                2026-08-17; window is configurable — official hours to be
 *                confirmed and set in `peakWindow`).
 *   - `offPeak`: the rate applied outside that window.
 * Usage is bucketed PER PERIOD: each usage event is priced by its own
 * `time` (epoch ms), so a conversation spanning both periods keeps exact
 * per-period totals and the total cost is always exact.
 *
 * Price sources (lowest → highest precedence):
 *   1. built-in defaults (DEFAULT_MODELS),
 *   2. auto-fetched official prices (periodic + on boot, best-effort),
 *   3. `config.models` from cordis.patch.yml,
 *   4. the `token-cost` user settings section (settings.yaml, hot-reload).
 * Browser-local overrides (right-click panel) live client-side and reprice
 * the display from the per-period token splits in the wire value.
 *
 * The fold keeps only per-period token buckets (pricing-independent);
 * `view()` prices them with the CURRENT table captured in the closure, so a
 * fetch or a settings edit re-prices immediately without invalidating the
 * fold (re-registering the unit on change, as before).
 */
import { Service } from "@deepseek-ai/cordis";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";

/** Settings namespace carrying the per-model pricing a user owns. */
const TOKEN_COST_NAMESPACE = settingsNamespace("token-cost");

/** Default official pricing page (HTML; parsed best-effort). */
const PRICING_PAGE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";

/** Default per-model pricing (RMB per 1,000,000 tokens), peak == offPeak until fetched. */
const DEFAULT_MODELS = {
	"deepseek-v4-pro": {
		label: "DeepSeek V4 Pro",
		currency: "¥",
		peak: { hitInput: 0.025, missInput: 3, output: 6 },
		offPeak: { hitInput: 0.025, missInput: 3, output: 6 }
	},
	"deepseek-v4-flash": {
		label: "DeepSeek V4 Flash",
		currency: "¥",
		peak: { hitInput: 0.02, missInput: 1, output: 2 },
		offPeak: { hitInput: 0.02, missInput: 1, output: 2 }
	}
};

/** Official page model ids → known model ids (first alias found on the page wins). */
const DEFAULT_ALIASES = {
	"deepseek-v4-pro": ["deepseek-v4-pro", "deepseek-chat", "deepseek-v3.2", "deepseek-v3"],
	"deepseek-v4-flash": ["deepseek-v4-flash", "deepseek-reasoner", "deepseek-r1"]
};

/** Zero rate used as the fallback base for a model with no table entry at all. */
const ZERO_RATE = { hitInput: 0, missInput: 0, output: 0 };

// ── Wire schemas (zod; `view()` output is validated against these) ────────
const rateSchema = zod.object({
	hitInput: zod.number().nonnegative(),
	missInput: zod.number().nonnegative(),
	output: zod.number().nonnegative()
}).strict();

const tokensSchema = zod.object({
	missInputTokens: zod.number().int().nonnegative(),
	hitInputTokens: zod.number().int().nonnegative(),
	outputTokens: zod.number().int().nonnegative()
}).strict();

const modelCostSchema = zod.object({
	model: zod.string(),
	label: zod.string(),
	currency: zod.string(),
	peak: rateSchema,
	offPeak: rateSchema,
	missInputTokens: zod.number().int().nonnegative(),
	hitInputTokens: zod.number().int().nonnegative(),
	outputTokens: zod.number().int().nonnegative(),
	totalTokens: zod.number().int().nonnegative(),
	cost: zod.number().nonnegative(),
	peakTokens: tokensSchema,
	offPeakTokens: tokensSchema
}).strict();

const peakSegmentSchema = zod.object({
	start: zod.string(),
	end: zod.string()
}).strict();

const peakWindowSchema = zod.object({
	enabled: zod.boolean(),
	timezone: zod.string(),
	segments: zod.array(peakSegmentSchema)
}).strict();

const tokenCostSchema = zod.object({
	missInputTokens: zod.number().int().nonnegative(),
	hitInputTokens: zod.number().int().nonnegative(),
	outputTokens: zod.number().int().nonnegative(),
	totalTokens: zod.number().int().nonnegative(),
	cost: zod.number().nonnegative(),
	peakWindow: peakWindowSchema,
	source: zod.enum(["default", "official"]),
	updatedAt: zod.number().nullable(),
	models: zod.array(modelCostSchema)
}).strict();

// ── Event extraction (faithful to dsh-token-meter) ────────────────────────
/** Extract provider usage from the two event kinds that carry it. */
function usageOf(event) {
	if (event.type === "assistant/chunk" && event.data.chunk.type === "usage") {
		return event.data.chunk.usage;
	}
	if (event.type === "assistant/message" && event.data.usage !== void 0) {
		return event.data.usage;
	}
	return void 0;
}

/** Map one usage record to its billing buckets. */
function bucketsFrom(usage) {
	return {
		uncachedInputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0
	};
}

function bucketsEqual(a, b) {
	return a.uncachedInputTokens === b.uncachedInputTokens
		&& a.outputTokens === b.outputTokens
		&& a.cacheReadTokens === b.cacheReadTokens
		&& a.cacheWriteTokens === b.cacheWriteTokens;
}

/** The model id an event pins the current route to, or undefined. */
function modelOf(event) {
	if (event.type === "request/header") {
		const model = event.data.header?.config?.model;
		return typeof model === "string" && model !== "" ? model : void 0;
	}
	if (event.type === "request/context") {
		const model = event.data.model;
		return typeof model === "string" && model !== "" ? model : void 0;
	}
	return void 0;
}

// ── Peak / off-peak window (one or more daily segments) ───────────────────
/** Official DeepSeek peak windows (Beijing time) per the 2026-08 pricing notice. */
const DEFAULT_SEGMENTS = [
	{ start: "09:00", end: "12:00" },
	{ start: "14:00", end: "18:00" }
];

/** "HH:MM" → minutes since midnight. */
function parseHHMM(value) {
	const [h, m] = String(value).split(":").map((part) => Number(part));
	return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** Normalize one daily segment (fallback on malformed fields). */
function normalizeSegment(value, fallback) {
	const s = value ?? {};
	return {
		start: typeof s.start === "string" && /^\d{1,2}:\d{2}$/.test(s.start) ? s.start : fallback.start,
		end: typeof s.end === "string" && /^\d{1,2}:\d{2}$/.test(s.end) ? s.end : fallback.end
	};
}

/**
 * Resolve the peak-window config. Accepts the CURRENT shape
 * `{ enabled, timezone, segments: [{start, end}, ...] }` and the LEGACY
 * single `{ enabled, timezone, start, end }` (migrated to one segment).
 * An empty segments list means no peak period at all (everything off-peak).
 */
function resolveWindow(value) {
	const v = value ?? {};
	let segments;
	if (Array.isArray(v.segments)) {
		segments = v.segments.length > 0
			? v.segments.map((segment, index) => normalizeSegment(segment, DEFAULT_SEGMENTS[index % DEFAULT_SEGMENTS.length]))
			: [];
	} else if (typeof v.start === "string" || typeof v.end === "string") {
		segments = [normalizeSegment(v, DEFAULT_SEGMENTS[0])];
	} else {
		segments = DEFAULT_SEGMENTS.map((segment) => ({ ...segment }));
	}
	return {
		enabled: v.enabled !== false,
		timezone: typeof v.timezone === "string" && v.timezone !== "" ? v.timezone : "Asia/Shanghai",
		segments
	};
}

/** Build the event-time → period classifier for one window (cached formatter). */
function makePeriodOf(window) {
	if (!window.enabled) return () => "peak";
	const windows = (window.segments ?? []).map((segment) => ({
		start: parseHHMM(segment.start),
		end: parseHHMM(segment.end)
	}));
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: window.timezone,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false
	});
	return (timeMs) => {
		if (typeof timeMs !== "number" || !Number.isFinite(timeMs)) return "peak";
		let h = 0;
		let m = 0;
		for (const part of fmt.formatToParts(new Date(timeMs))) {
			if (part.type === "hour") h = Number(part.value) === 24 ? 0 : Number(part.value);
			else if (part.type === "minute") m = Number(part.value);
		}
		const t = h * 60 + m;
		for (const { start, end } of windows) {
			const inSegment = start <= end ? t >= start && t < end : t >= start || t < end;
			if (inSegment) return "peak";
		}
		return "offPeak";
	};
}

// ── Pricing table merge / normalization ───────────────────────────────────
function validateNum(key, n) {
	if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
		throw new Error(`token-cost ${key} must be a non-negative number`);
	}
	return n;
}

/** Copy the present fields of one rate object over a fallback rate. */
function normalizeRate(value, fallback) {
	const out = { ...fallback };
	if (value !== void 0 && value !== null && typeof value === "object") {
		for (const key of ["hitInput", "missInput", "output"]) {
			if (value[key] !== void 0) out[key] = validateNum(key, value[key]);
		}
	}
	return out;
}

/**
 * Normalize one model entry to the canonical {label, currency, peak, offPeak}
 * shape. Accepts the NEW shape and the LEGACY flat shape ({hitInput, ...}
 * applies to both periods) for settings.yaml / config migration.
 */
function normalizeModelEntry(value, fallback) {
	const entry = value ?? {};
	const flat = entry.hitInput !== void 0 || entry.missInput !== void 0 || entry.output !== void 0;
	const peak = entry.peak !== void 0 && typeof entry.peak === "object" ? entry.peak : flat ? entry : void 0;
	const offPeak = entry.offPeak !== void 0 && typeof entry.offPeak === "object" ? entry.offPeak : flat ? entry : void 0;
	return {
		label: typeof entry.label === "string" && entry.label !== "" ? entry.label : fallback.label,
		currency: typeof entry.currency === "string" && entry.currency !== "" ? entry.currency : fallback.currency,
		peak: normalizeRate(peak, fallback.peak),
		offPeak: normalizeRate(offPeak, fallback.offPeak)
	};
}

/** Base entry for a model with no defaults (used for fetched new models). */
function baseEntryFor(modelId) {
	return {
		label: modelId.replace(/^deepseek-/, "DeepSeek ").replace(/-/g, " "),
		currency: "¥",
		peak: { ...ZERO_RATE },
		offPeak: { ...ZERO_RATE }
	};
}

/**
 * Merge pricing layers into one table. `layers` are plain
 * `{ modelId: entry }` objects (or undefined), LOWEST precedence first;
 * entries merge field-by-field over the accumulated value, so partial /
 * legacy-flat entries never clobber unrelated fields.
 */
function mergePricing(layers) {
	const ids = new Set();
	for (const layer of layers) {
		if (layer === void 0 || layer === null) continue;
		for (const id of Object.keys(layer)) ids.add(id);
	}
	const out = {};
	for (const id of ids) {
		const fallback = DEFAULT_MODELS[id] ?? baseEntryFor(id);
		let current = {
			label: fallback.label,
			currency: fallback.currency,
			peak: { ...fallback.peak },
			offPeak: { ...fallback.offPeak }
		};
		for (const layer of layers) {
			if (layer === void 0 || layer === null || !(id in layer)) continue;
			current = normalizeModelEntry(layer[id], current);
		}
		out[id] = current;
	}
	return out;
}

/** Normalize (and validate) a whole user settings section against defaults. */
function normalizeSection(section, defaults) {
	const out = {};
	for (const [id, entry] of Object.entries(section)) {
		const fallback = defaults[id] ?? baseEntryFor(id);
		out[id] = normalizeModelEntry(entry, fallback);
	}
	return out;
}

// ── Projection unit ───────────────────────────────────────────────────────
/**
 * Build the `tokenCost` projection with the pricing table and peak window
 * baked in. Same last-sample-replacing fold as token-meter's usage
 * projection, keyed per model AND per period (peak/offPeak). State keeps
 * only token buckets; `view()` prices with the closure table.
 */
function makeTokenCostProjection(table, window, sourceLabel, updatedAt) {
	const knownModels = Object.keys(table);
	const periodOf = makePeriodOf(window);
	const zeroPeriod = () => ({ miss: 0, hit: 0, out: 0 });
	const zeroBucket = () => ({ peak: zeroPeriod(), offPeak: zeroPeriod() });
	const zeroTotals = () => {
		const byModel = {};
		for (const modelId of knownModels) byModel[modelId] = zeroBucket();
		return byModel;
	};
	/** Accumulate `buckets` into `target[model][period]`, replacing a prior sample. */
	function foldInto(target, model, period, buckets, previous) {
		const cur = target[model] ?? zeroBucket();
		const next = { peak: zeroPeriod(), offPeak: zeroPeriod() };
		for (const rate of ["peak", "offPeak"]) {
			const was = previous !== void 0 && previous.period === rate ? previous.buckets : void 0;
			const is = rate === period ? buckets : void 0;
			next[rate].miss = cur[rate].miss
				- (was?.uncachedInputTokens ?? 0) - (was?.cacheWriteTokens ?? 0)
				+ (is?.uncachedInputTokens ?? 0) + (is?.cacheWriteTokens ?? 0);
			next[rate].hit = cur[rate].hit
				- (was?.cacheReadTokens ?? 0)
				+ (is?.cacheReadTokens ?? 0);
			next[rate].out = cur[rate].out
				- (was?.outputTokens ?? 0)
				+ (is?.outputTokens ?? 0);
		}
		return { ...target, [model]: next };
	}
	return {
		key: "tokenCost",
		schema: tokenCostSchema,
		init: () => ({ totals: zeroTotals(), currentModel: null, last: null }),
		apply: (state, event) => {
			const usage = usageOf(event);
			if (usage !== void 0) {
				const turn = event.data.turn;
				const step = event.data.step;
				const buckets = bucketsFrom(usage);
				const previous = state.last !== null && state.last.turn === turn && state.last.step === step
					? state.last
					: void 0;
				const period = periodOf(event.time);
				if (previous !== void 0 && previous.period === period && bucketsEqual(previous.buckets, buckets)) {
					return state;
				}
				const model = state.currentModel;
				if (model === null) return state;
				return {
					totals: foldInto(state.totals, model, period, buckets, previous),
					currentModel: state.currentModel,
					last: { turn, step, period, buckets }
				};
			}
			const model = modelOf(event);
			if (model !== void 0 && model !== state.currentModel) {
				return { ...state, currentModel: model };
			}
			return state;
		},
		view: (state) => {
			// NOTE: `rows` is the local result array; `table` stays the closure
			// pricing table. Conflating the two once made `pricing.missInput`
			// throw on every history load ("Cannot read properties of
			// undefined (reading 'missInput')") — view() must NEVER throw.
			const rows = [];
			let missInputTokens = 0;
			let hitInputTokens = 0;
			let outputTokens = 0;
			let cost = 0;
			for (const modelId of knownModels) {
				const pricing = table[modelId] ?? baseEntryFor(modelId);
				const bucket = state.totals[modelId] ?? zeroBucket();
				const miss = bucket.peak.miss + bucket.offPeak.miss;
				const hit = bucket.peak.hit + bucket.offPeak.hit;
				const out = bucket.peak.out + bucket.offPeak.out;
				const totalTokens = miss + hit + out;
				const modelCost = (
					bucket.peak.miss * pricing.peak.missInput
					+ bucket.peak.hit * pricing.peak.hitInput
					+ bucket.peak.out * pricing.peak.output
					+ bucket.offPeak.miss * pricing.offPeak.missInput
					+ bucket.offPeak.hit * pricing.offPeak.hitInput
					+ bucket.offPeak.out * pricing.offPeak.output
				) / 1e6;
				missInputTokens += miss;
				hitInputTokens += hit;
				outputTokens += out;
				cost += modelCost;
				rows.push({
					model: modelId,
					label: pricing.label,
					currency: pricing.currency,
					peak: { ...pricing.peak },
					offPeak: { ...pricing.offPeak },
					missInputTokens: miss,
					hitInputTokens: hit,
					outputTokens: out,
					totalTokens,
					cost: modelCost,
					peakTokens: { missInputTokens: bucket.peak.miss, hitInputTokens: bucket.peak.hit, outputTokens: bucket.peak.out },
					offPeakTokens: { missInputTokens: bucket.offPeak.miss, hitInputTokens: bucket.offPeak.hit, outputTokens: bucket.offPeak.out }
				});
			}
			// Unknown-model buckets still count into the totals (unpriced, unlisted).
			for (const [modelId, bucket] of Object.entries(state.totals)) {
				if (knownModels.includes(modelId)) continue;
				missInputTokens += bucket.peak.miss + bucket.offPeak.miss;
				hitInputTokens += bucket.peak.hit + bucket.offPeak.hit;
				outputTokens += bucket.peak.out + bucket.offPeak.out;
			}
			const grandTotal = missInputTokens + hitInputTokens + outputTokens;
			return {
				missInputTokens,
				hitInputTokens,
				outputTokens,
				totalTokens: grandTotal,
				cost,
				peakWindow: {
					enabled: window.enabled,
					timezone: window.timezone,
					segments: window.segments.map((segment) => ({ ...segment }))
				},
				source: sourceLabel,
				updatedAt,
				models: rows
			};
		},
		stateVersion: 4
	};
}

// ── Official pricing page parser (best-effort, defensive) ─────────────────
const MODEL_ID_RE = /deepseek-[\w.-]+/i;

/** Split rows of one table segment at each model id occurrence. */
function extractRows(segment) {
	const rows = [];
	const re = new RegExp(`(${MODEL_ID_RE.source})`, "gi");
	const parts = [];
	let match;
	while ((match = re.exec(segment)) !== null) {
		parts.push({ id: match[0].toLowerCase(), start: match.index });
	}
	for (let i = 0; i < parts.length; i += 1) {
		const end = i + 1 < parts.length ? parts[i + 1].start : segment.length;
		const start = parts[i].start + parts[i].id.length;
		rows.push({ id: parts[i].id, text: segment.slice(start, end) });
	}
	return rows;
}

/** Pull {hitInput, missInput, output} from one row's text (keyword-first). */
function pricesOfRow(text) {
	const out = {};
	const keywords = [
		{ key: "hitInput", re: /命中/ },
		{ key: "missInput", re: /未命中/ },
		{ key: "output", re: /输出|生成/ }
	];
	for (const { key, re } of keywords) {
		const at = text.search(re);
		if (at === -1) continue;
		const window = text.slice(at, at + 80);
		const num = window.match(/(\d+(?:\.\d+)?)/);
		if (num !== null) out[key] = Number(num[0]);
	}
	if (Object.keys(out).length === 0) {
		// positional fallback: first three plausible amounts in column order
		const nums = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map((n) => Number(n[0])).filter((n) => n >= 0.001);
		if (nums.length >= 3) {
			out.hitInput = nums[0];
			out.missInput = nums[1];
			out.output = nums[2];
		}
	}
	return out;
}

function findSection(text, labelRe, stopRe) {
	const at = text.search(labelRe);
	if (at === -1) return void 0;
	const rest = text.slice(at);
	if (stopRe === void 0) return rest;
	const stop = rest.search(stopRe);
	return stop === -1 ? rest : rest.slice(0, stop);
}

/**
 * Parse the official pricing page into `{ table }` where table maps model id
 * → {label, currency, peak, offPeak}. Returns null when the page has no
 * recognizable structure (caller keeps previous prices).
 */
function parsePricingHtml(html, aliases = DEFAULT_ALIASES) {
	if (typeof html !== "string" || html.length < 200) return null;
	const text = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ");
	const peakSegment = findSection(text, /高峰|peak/i, /闲时|空闲|非高峰|off[\s-]?peak/i);
	if (peakSegment === void 0) return null;
	const offSegment = findSection(text, /闲时|空闲|非高峰|off[\s-]?peak/i);
	const parseSegment = (segment) => {
		const table = {};
		for (const row of extractRows(segment)) {
			if (row.id in table) continue; // first row of a model wins (peak table precedes off-peak)
			const prices = pricesOfRow(row.text);
			if (Object.keys(prices).length < 2) continue;
			table[row.id] = prices;
		}
		return table;
	};
	const peakTable = parseSegment(peakSegment);
	const offTable = offSegment === void 0 ? peakTable : parseSegment(offSegment);
	if (Object.keys(peakTable).length === 0) return null;
	const currency = /[¥￥]/.test(text) ? "¥" : /[$]/.test(text) ? "$" : "¥";
	const resolved = new Set();
	const table = {};
	const resolveAlias = (pageId) => {
		for (const [known, list] of Object.entries(aliases)) {
			if (list.some((alias) => String(alias).toLowerCase() === pageId)) return known;
		}
		return pageId;
	};
	for (const [pageId, prices] of Object.entries(peakTable)) {
		const id = resolveAlias(pageId);
		if (resolved.has(id)) continue;
		resolved.add(id);
		const fallback = DEFAULT_MODELS[id] ?? baseEntryFor(id);
		table[id] = {
			label: fallback.label,
			currency,
			peak: normalizeRate(prices, fallback.peak),
			offPeak: normalizeRate(offTable[pageId] ?? prices, fallback.offPeak)
		};
	}
	return Object.keys(table).length > 0 ? { table } : null;
}

/** Fetch and parse the official pricing page; throws on any failure. */
async function fetchPricingPage(url, timeoutMs) {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(timeoutMs),
		headers: { "user-agent": "Mozilla/5.0" }
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const parsed = parsePricingHtml(await res.text());
	if (parsed === null) throw new Error("no recognizable pricing table in page");
	return parsed.table;
}

/** Resolve the fetch config with defaults (fetch is OPT-IN; default off, user fills manually). */
function resolvePricingSource(value) {
	const v = value ?? {};
	return {
		url: typeof v.url === "string" && v.url !== "" ? v.url : PRICING_PAGE_URL,
		enabled: v.enabled === true,
		refreshMs: Number.isFinite(v.refreshMinutes) && v.refreshMinutes > 0
			? Math.round(v.refreshMinutes * 60_000)
			: 360 * 60_000,
		timeoutMs: Number.isFinite(v.timeoutMs) && v.timeoutMs > 0 ? Math.round(v.timeoutMs) : 20_000
	};
}

/** Settings schema: dict of model entries (all fields optional in schemastery). */
function makeSettingsSchema() {
	const rate = () => z.object({
		hitInput: z.number(),
		missInput: z.number(),
		output: z.number()
	});
	return z.dict(z.object({
		label: z.string(),
		currency: z.string(),
		// legacy flat shape (applies to both periods)
		hitInput: z.number(),
		missInput: z.number(),
		output: z.number(),
		peak: rate(),
		offPeak: rate()
	}));
}

/**
 * Merge a raw user settings section over the live table and config window.
 * The section may carry a `peakWindow` key alongside model entries.
 */
function applyUserSection(userSection, baseTable, configWindow) {
	const user = userSection ?? {};
	const { peakWindow: userWindow, ...userModels } = user;
	return {
		window: resolveWindow({ ...configWindow, ...(userWindow ?? {}) }),
		table: mergePricing([baseTable, userModels])
	};
}

// ── Minimal HTTP helpers for the panel→host settings route ───────────────
function sendJson(response, status, payload) {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8"
	});
	response.end(JSON.stringify(payload));
}

/** True when the request's Origin matches its Host — required on the POST route. */
function sameOrigin(request) {
	const origin = request.headers.origin;
	const host = request.headers.host;
	if (origin === void 0 || host === void 0) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

/** Read and parse a JSON request body, rejecting anything over 4 KiB. */
async function readJsonBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 4096) throw new Error("request body too large");
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

var TokenCostService = class extends Service {
	static inject = ["sessionProjections"];
	// All fields optional by default in schemastery → any absent/partial config loads.
	static Config = z.object({
		// .default(undefined) keeps ABSENT keys absent (schemastery otherwise
		// fills missing arrays/objects with []/{} — an empty segments array
		// would be read as "no peak period" instead of the official window).
		models: z.dict(z.object({
			label: z.string(),
			currency: z.string(),
			hitInput: z.number(),
			missInput: z.number(),
			output: z.number(),
			peak: z.object({ hitInput: z.number(), missInput: z.number(), output: z.number() }),
			offPeak: z.object({ hitInput: z.number(), missInput: z.number(), output: z.number() })
		})).default(undefined),
		pricingSource: z.object({
			url: z.string(),
			enabled: z.boolean(),
			refreshMinutes: z.number(),
			timeoutMs: z.number()
		}).default(undefined),
		peakWindow: z.object({
			enabled: z.boolean(),
			timezone: z.string(),
			// legacy single-window fields (migrated to segments) + current shape
			start: z.string(),
			end: z.string(),
			segments: z.array(z.object({ start: z.string(), end: z.string() }))
		}).default(undefined),
		aliases: z.dict(z.array(z.string())).default(undefined)
	});

	constructor(ctx, config = {}) {
		super(ctx, "tokenCost");
		const patch = config.models;
		const window = resolveWindow(config.peakWindow);
		const pricingSource = resolvePricingSource(config.pricingSource);
		const aliases = config.aliases ?? DEFAULT_ALIASES;

		let fetched = void 0;
		let fetchedAt = null;
		let baseTable = mergePricing([DEFAULT_MODELS, fetched, patch]);

		// source() yields { window, table } — the effective window may be
		// overridden by the user settings section (panel → settings.yaml).
		let source = () => ({ window, table: baseTable });
		let disposeProjection = void 0;
		const reprice = () => {
			if (disposeProjection !== void 0) disposeProjection();
			const { window: effWindow, table } = source();
			const sourceLabel = fetchedAt !== null ? "official" : "default";
			disposeProjection = ctx.sessionProjections.register(
				makeTokenCostProjection(table, effWindow, sourceLabel, fetchedAt)
			);
		};

		// User settings section (settings.yaml, hot-reload) merges over the
		// LIVE base table and may override the peak window at reprice time.
		// (Hand-rolled installSettingsSection so the fetch and the panel
		// route can change the base; the apiproxy allowlist does NOT expose
		// this namespace to the Web client, hence the host route below.)
		ctx.inject(["settings"], (sctx) => {
			const scope = sctx.settings.register(TOKEN_COST_NAMESPACE, makeSettingsSchema(), {
				base: mergePricing([DEFAULT_MODELS, patch]),
				validate: (value) => void normalizeSection(value, DEFAULT_MODELS)
			});
			const readUser = () => {
				try {
					return sctx.settings.section(TOKEN_COST_NAMESPACE) ?? {};
				} catch {
					return {};
				}
			};
			source = () => applyUserSection(readUser(), baseTable, window);
			sctx.effect(() => () => {
				source = () => ({ window, table: baseTable });
			});
			scope.watch(() => reprice());
			reprice();
		});

		// Browser panel → host settings route (same-origin POST only). The
		// panel writes prices and/or the peak window; the host persists them
		// into the settings provider (settings.yaml) and re-prices via the
		// scope watcher above.
		ctx.inject(["webServer", "settings"], (sctx) => {
			const disposer = sctx.webServer.register({
				kind: "exact",
				path: "/dsh-token-cost/settings",
				handler: async (request, response) => {
					if (request.method !== "POST") {
						response.writeHead(405, { allow: "POST" });
						response.end();
						return;
					}
					if (!sameOrigin(request)) {
						response.writeHead(403);
						response.end();
						return;
					}
					let body;
					try {
						body = await readJsonBody(request);
					} catch {
						sendJson(response, 400, { error: "invalid JSON body" });
						return;
					}
					try {
						if (body.reset === true) {
							await sctx.settings.replace(TOKEN_COST_NAMESPACE, {});
						} else {
							const patch = {};
							if (body.peakWindow !== void 0) patch.peakWindow = resolveWindow(body.peakWindow);
							if (body.models !== void 0) patch.models = normalizeSection(body.models, DEFAULT_MODELS);
							if (Object.keys(patch).length === 0) {
								sendJson(response, 400, { error: "nothing to update" });
								return;
							}
							await sctx.settings.update(TOKEN_COST_NAMESPACE, patch);
						}
						sendJson(response, 200, { ok: true });
					} catch (error) {
						sendJson(response, 400, { error: error?.message ?? String(error) });
					}
				}
			});
			sctx.effect(() => () => disposer(), "token-cost: settings route");
		});

		// Auto price refresh: OPT-IN (pricingSource.enabled: true). On boot +
		// periodic; failures keep the old table.
		let fetching = false;
		const applyFetched = (table) => {
			fetched = table;
			fetchedAt = Date.now();
			baseTable = mergePricing([DEFAULT_MODELS, fetched, patch]);
			reprice();
		};
		this.refreshPricing = async () => {
			if (fetching || !pricingSource.enabled) return;
			fetching = true;
			try {
				const table = await fetchPricingPage(pricingSource.url, pricingSource.timeoutMs, aliases);
				applyFetched(table);
				ctx.logger.info("token-cost: pricing refreshed from %s", pricingSource.url);
			} catch (error) {
				ctx.logger.warn("token-cost: pricing fetch failed (%s); keeping previous prices", error?.message ?? String(error));
			} finally {
				fetching = false;
			}
		};
		if (pricingSource.enabled) {
			void this.refreshPricing();
			const timer = setInterval(() => void this.refreshPricing(), pricingSource.refreshMs);
			ctx.effect(() => () => clearInterval(timer), "token-cost: pricing refresh timer");
		}

		// Ensure a projection exists even before/without the settings service.
		if (disposeProjection === void 0) reprice();
	}
};
//#endregion
export {
	DEFAULT_MODELS,
	TokenCostService,
	TokenCostService as default,
	applyUserSection,
	fetchPricingPage,
	makePeriodOf,
	makeTokenCostProjection,
	mergePricing,
	normalizeModelEntry,
	parsePricingHtml,
	resolvePricingSource,
	resolveWindow
};
