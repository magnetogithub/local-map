//#region src/lib/world/canonical-serializer.ts
var e = (e, t) => e < t ? -1 : +(e > t), t = (e, t) => {
	throw TypeError(`Canonical serialization rejected ${e}: ${t}`);
};
function n(r, i, a) {
	if (r === null) return "null";
	switch (typeof r) {
		case "string": return JSON.stringify(r);
		case "boolean": return r ? "true" : "false";
		case "number": return Number.isFinite(r) || t(i, "number must be finite"), JSON.stringify(Object.is(r, -0) ? 0 : r);
		case "undefined": return t(i, "undefined is not supported");
		case "function":
		case "symbol":
		case "bigint": return t(i, `${typeof r} is not supported`);
	}
	a.has(r) && t(i, "circular structure"), a.add(r);
	try {
		if (Array.isArray(r)) {
			let e = [];
			for (let t = 0; t < r.length; t += 1) e.push(n(r[t], `${i}[${t}]`, a));
			return `[${e.join(",")}]`;
		}
		let o = Object.getPrototypeOf(r);
		o !== Object.prototype && o !== null && t(i, "only arrays and plain objects are supported"), Object.getOwnPropertySymbols(r).length > 0 && t(i, "symbol properties are not supported");
		let s = Object.getOwnPropertyDescriptors(r);
		return `{${Object.keys(s).sort(e).map((e) => {
			let r = s[e];
			return r.enumerable || t(`${i}.${e}`, "non-enumerable properties are not supported"), "value" in r || t(`${i}.${e}`, "accessor properties are not supported"), `${JSON.stringify(e)}:${n(r.value, `${i}.${e}`, a)}`;
		}).join(",")}}`;
	} finally {
		a.delete(r);
	}
}
function r(e) {
	return n(e, "$", /* @__PURE__ */ new Set());
}
function i(e) {
	return new TextEncoder().encode(r(e));
}
//#endregion
//#region src/lib/world/sha256.ts
var a = [
	1779033703,
	3144134277,
	1013904242,
	2773480762,
	1359893119,
	2600822924,
	528734635,
	1541459225
], o = [
	1116352408,
	1899447441,
	3049323471,
	3921009573,
	961987163,
	1508970993,
	2453635748,
	2870763221,
	3624381080,
	310598401,
	607225278,
	1426881987,
	1925078388,
	2162078206,
	2614888103,
	3248222580,
	3835390401,
	4022224774,
	264347078,
	604807628,
	770255983,
	1249150122,
	1555081692,
	1996064986,
	2554220882,
	2821834349,
	2952996808,
	3210313671,
	3336571891,
	3584528711,
	113926993,
	338241895,
	666307205,
	773529912,
	1294757372,
	1396182291,
	1695183700,
	1986661051,
	2177026350,
	2456956037,
	2730485921,
	2820302411,
	3259730800,
	3345764771,
	3516065817,
	3600352804,
	4094571909,
	275423344,
	430227734,
	506948616,
	659060556,
	883997877,
	958139571,
	1322822218,
	1537002063,
	1747873779,
	1955562222,
	2024104815,
	2227730452,
	2361852424,
	2428436474,
	2756734187,
	3204031479,
	3329325298
], s = (e, t) => e >>> t | e << 32 - t;
function c(e) {
	let t = Math.ceil((e.length + 9) / 64) * 64, n = new Uint8Array(t);
	n.set(e), n[e.length] = 128;
	let r = e.length * 8, i = new DataView(n.buffer);
	i.setUint32(t - 8, Math.floor(r / 4294967296), !1), i.setUint32(t - 4, r >>> 0, !1);
	let c = new Uint32Array(a), l = /* @__PURE__ */ new Uint32Array(64);
	for (let e = 0; e < n.length; e += 64) {
		for (let t = 0; t < 16; t += 1) l[t] = i.getUint32(e + t * 4, !1);
		for (let e = 16; e < 64; e += 1) {
			let t = l[e - 15], n = l[e - 2], r = s(t, 7) ^ s(t, 18) ^ t >>> 3, i = s(n, 17) ^ s(n, 19) ^ n >>> 10;
			l[e] = l[e - 16] + r + l[e - 7] + i >>> 0;
		}
		let t = c[0], n = c[1], r = c[2], a = c[3], u = c[4], d = c[5], f = c[6], p = c[7];
		for (let e = 0; e < 64; e += 1) {
			let i = s(u, 6) ^ s(u, 11) ^ s(u, 25), c = u & d ^ ~u & f, m = p + i + c + o[e] + l[e] >>> 0, h = (s(t, 2) ^ s(t, 13) ^ s(t, 22)) + (t & n ^ t & r ^ n & r) >>> 0;
			p = f, f = d, d = u, u = a + m >>> 0, a = r, r = n, n = t, t = m + h >>> 0;
		}
		c[0] = c[0] + t >>> 0, c[1] = c[1] + n >>> 0, c[2] = c[2] + r >>> 0, c[3] = c[3] + a >>> 0, c[4] = c[4] + u >>> 0, c[5] = c[5] + d >>> 0, c[6] = c[6] + f >>> 0, c[7] = c[7] + p >>> 0;
	}
	return [...c].map((e) => e.toString(16).padStart(8, "0")).join("");
}
//#endregion
//#region src/lib/world/domain-hash-root.ts
var l = /^[a-f0-9]{64}$/;
function u(e, t) {
	if (typeof e != "string" || !l.test(e)) throw TypeError(`${t} must be a lowercase SHA-256 leaf hash`);
}
//#endregion
//#region src/lib/world/immutable-readonly-set.ts
var d = (e) => {
	let t = [];
	for (let n = e.next(); !n.done; n = e.next()) t.push(n.value);
	return t;
}, f = class {
	constructor(e) {
		this.valuesSnapshot = Object.freeze([...new Set(e)]), Object.freeze(this);
	}
	get size() {
		return this.valuesSnapshot.length;
	}
	has(e) {
		return this.valuesSnapshot.includes(e);
	}
	forEach(e, t) {
		this.valuesSnapshot.forEach((n) => e.call(t, n, n, this));
	}
	entries() {
		return this.valuesSnapshot.map((e) => [e, e]).values();
	}
	keys() {
		return this.valuesSnapshot.values();
	}
	values() {
		return this.valuesSnapshot.values();
	}
	[Symbol.iterator]() {
		return this.valuesSnapshot.values();
	}
	union(e) {
		return /* @__PURE__ */ new Set([...this.valuesSnapshot, ...d(e.keys())]);
	}
	intersection(e) {
		let t = e;
		return new Set(this.valuesSnapshot.filter((e) => t.has(e)));
	}
	difference(e) {
		let t = e;
		return new Set(this.valuesSnapshot.filter((e) => !t.has(e)));
	}
	symmetricDifference(e) {
		let t = this.difference(e);
		for (let n of d(e.keys())) this.has(n) || t.add(n);
		return t;
	}
	isSubsetOf(e) {
		return this.valuesSnapshot.every((t) => e.has(t));
	}
	isSupersetOf(e) {
		for (let t of d(e.keys())) if (!this.has(t)) return !1;
		return !0;
	}
	isDisjointFrom(e) {
		return this.valuesSnapshot.every((t) => !e.has(t));
	}
};
function p(e) {
	return new f(e);
}
//#endregion
//#region src/lib/world/country-id.ts
var m = /^[A-Z][A-Z0-9]{2}$/, h = class extends Error {
	constructor(e, t) {
		super(t), this.name = "CountryIdError", this.code = e;
	}
};
function g(e, t) {
	if (typeof e != "string") throw new h("invalid-country-id", `${t} must be a non-empty string`);
	let n = e.trim();
	if (n.length === 0) throw new h("invalid-country-id", `${t} must be a non-empty string`);
	if (e !== n) throw new h("invalid-country-id", `${t} must not contain surrounding whitespace`);
	if (!m.test(e)) throw new h("invalid-country-id", `${t} must be exactly 3 uppercase alphanumeric characters and start with a letter`);
	return e;
}
function _(e, t) {
	let n = /* @__PURE__ */ new Set();
	for (let r of e) {
		let e = g(r, `${t} CountryId`);
		if (n.has(e)) throw new h("duplicate-country-id", `Duplicate ${t} CountryId: ${e}`);
		n.add(e);
	}
	return n;
}
function v(e) {
	let t = _(e.activeCountryIds, "active"), n = _(e.retiredCountryIds, "retired");
	for (let e of t) if (n.has(e)) throw new h("country-id-lifecycle-conflict", `CountryId cannot be both active and retired: ${e}`);
	return Object.freeze({
		activeCountryIds: p(t),
		retiredCountryIds: p(n)
	});
}
//#endregion
//#region src/lib/world/world-v3-validation.ts
var y = (e, t) => e < t ? -1 : +(e > t);
function b(e, t) {
	if (!e || typeof e != "object" || Array.isArray(e)) throw Error(`${t} must be a plain object record`);
	let n = Object.getPrototypeOf(e);
	if (n !== Object.prototype && n !== null) throw Error(`${t} must be a plain object record`);
	if (Object.getOwnPropertySymbols(e).length) throw Error(`${t} must not contain symbol fields`);
	for (let [n, r] of Object.entries(Object.getOwnPropertyDescriptors(e))) if ([
		"__proto__",
		"constructor",
		"prototype"
	].includes(n) || !r.enumerable || !("value" in r)) throw Error(`${t} contains a forbidden field: ${n}`);
	return e;
}
function x(e, t, n) {
	let r = Object.keys(e).sort(y), i = [...t].sort(y);
	if (r.length !== i.length || r.some((e, t) => e !== i[t])) throw Error(`${n} contains unknown or missing fields`);
}
function S(e, t) {
	if (!Array.isArray(e) || Object.getPrototypeOf(e) !== Array.prototype) throw Error(`${t} must be a plain array`);
	if (Object.getOwnPropertySymbols(e).length) throw Error(`${t} contains symbol fields`);
	let n = Object.getOwnPropertyDescriptors(e);
	for (let [r, i] of Object.entries(n)) if (r !== "length" && (!/^(0|[1-9][0-9]*)$/.test(r) || Number(r) >= e.length || !i.enumerable || !("value" in i))) throw Error(`${t} contains a forbidden array field: ${r}`);
	for (let r = 0; r < e.length; r++) if (!Object.hasOwn(n, String(r))) throw Error(`${t} must not contain array holes`);
	return e;
}
function C(e, t, n = /* @__PURE__ */ new Set()) {
	if (!(typeof e != "object" || !e)) {
		if (n.has(e)) throw Error(`${t} must not contain circular data`);
		if (n.add(e), Array.isArray(e)) for (let r of S(e, t)) C(r, t, n);
		else for (let [r, i] of Object.entries(b(e, t))) C(i, `${t}.${r}`, n);
		n.delete(e);
	}
}
function w(e, t) {
	if (typeof e != "string" || !m.test(e)) throw Error(`${t} must be a canonical CountryId`);
	return e;
}
function T(e, t) {
	if (typeof e != "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(e)) throw Error(`${t} must be a bounded ASCII canonical version`);
	return e;
}
function E(e, t, n) {
	let r = Array.from(S(e, n), (e) => t(e, n));
	if (r.some((e, t) => t > 0 && y(r[t - 1], e) >= 0)) throw Error(`${n} must be bytewise sorted without duplicates`);
	return Object.freeze(r);
}
function D(e, t, n) {
	let r = Object.keys(e).sort(y);
	if (r.length !== t.length || r.some((e, n) => e !== t[n])) throw Error(`${n} record and order must contain exactly the same IDs`);
}
//#endregion
//#region src/lib/world/world-geometry-catalog-ref.ts
function O(e, t = "Catalog TerritoryId") {
	if (typeof e != "string" || !/^territory:catalog:[a-f0-9]{64}$/.test(e)) throw Error(`${t} must be a bounded ASCII catalog TerritoryId`);
	return e;
}
function k(e) {
	let t = b(e, "WorldGeometryCatalogRef");
	x(t, [
		"catalogVersion",
		"geometryRoot",
		"topologyRoot",
		"renderArtifactRoot",
		"manifestPath"
	], "WorldGeometryCatalogRef");
	for (let e of [
		"geometryRoot",
		"topologyRoot",
		"renderArtifactRoot"
	]) u(t[e], `WorldGeometryCatalogRef.${e}`);
	let n = T(t.catalogVersion, "catalogVersion"), r = t.manifestPath;
	if (typeof r != "string" || r.length > 512 || !/^\/data\/[A-Za-z0-9._/-]+\.json$/.test(r) || r.split("/").some((e, t) => t > 0 && (!e || e === "." || e === "..")) || !r.split("/").includes(n)) throw Error("manifestPath must be a local versioned /data/ JSON path without traversal");
	return Object.freeze({
		catalogVersion: n,
		geometryRoot: t.geometryRoot,
		topologyRoot: t.topologyRoot,
		renderArtifactRoot: t.renderArtifactRoot,
		manifestPath: r
	});
}
function A(e) {
	let t = b(e, "WorldGeometryCatalogContract");
	x(t, [
		"ref",
		"territoriesById",
		"territoryOrder"
	], "WorldGeometryCatalogContract");
	let n = k(t.ref), r = E(t.territoryOrder, O, "catalog.territoryOrder"), i = b(t.territoriesById, "catalog.territoriesById");
	D(i, r, "catalog territories");
	let a = {};
	for (let e of r) {
		let t = b(i[e], "catalog entry");
		if (x(t, ["id", "sourceCountryId"], "catalog entry"), O(t.id) !== e) throw Error("Catalog record key must match entry id");
		a[e] = Object.freeze({
			id: e,
			sourceCountryId: w(t.sourceCountryId, "sourceCountryId")
		});
	}
	return Object.freeze({
		ref: n,
		territoryOrder: r,
		territoriesById: Object.freeze(a)
	});
}
function j(e, t) {
	for (let n of Object.keys(t)) if (e[n] !== t[n]) throw Error(`Catalog ref mismatch: ${n}`);
}
//#endregion
//#region src/lib/world/country-names.ts
var ee = [
	"english",
	"mapKo",
	"officialKo",
	"searchAliases",
	"shortKo"
], M = (e, t) => {
	if (typeof e != "string" || e.trim().length === 0) throw Error(`${t} must be a non-empty string`);
	return e;
}, te = (e, t, n) => {
	let r = Object.keys(e).sort();
	if (r.length !== t.length || r.some((e, n) => e !== t[n])) throw Error(`${n} contains unknown or missing fields`);
};
function ne(e) {
	if (!e || typeof e != "object" || Array.isArray(e)) throw Error("CountryNames must be an object");
	te(e, ee, "CountryNames");
	let t = e;
	if (!Array.isArray(t.searchAliases)) throw Error("CountryNames.searchAliases must be an array");
	let n = t.searchAliases.map((e, t) => M(e, `CountryNames.searchAliases[${t}]`));
	return Object.freeze(n), Object.freeze({
		shortKo: M(t.shortKo, "CountryNames.shortKo"),
		officialKo: M(t.officialKo, "CountryNames.officialKo"),
		mapKo: M(t.mapKo, "CountryNames.mapKo"),
		english: M(t.english, "CountryNames.english"),
		searchAliases: n
	});
}
//#endregion
//#region src/lib/world/country-presentation-override.ts
var re = /* @__PURE__ */ new Set([
	"center",
	"defaultZoom",
	"labelAnchor",
	"labelScale",
	"policyVersion",
	"reason"
]), N = (e, t) => {
	if (typeof e != "string" || e.trim().length === 0 || e !== e.trim()) throw Error(`CountryPresentationOverride.${t} must be non-empty canonical text`);
	return e;
}, ie = (e, t) => {
	if (!Array.isArray(e) || e.length !== 2 || !e.every((e) => typeof e == "number" && Number.isFinite(e))) throw Error(`CountryPresentationOverride.${t} must contain two finite coordinates`);
	return Object.freeze([e[0], e[1]]);
}, ae = (e, t) => {
	if (typeof e != "number" || !Number.isFinite(e) || e <= 0) throw Error(`CountryPresentationOverride.${t} must be a positive finite number`);
	return e;
};
function oe(e) {
	if (!e || typeof e != "object" || Array.isArray(e)) throw Error("CountryPresentationOverride must be an object");
	let t = e;
	if (Object.keys(t).some((e) => !re.has(e))) throw Error("CountryPresentationOverride contains an unknown field");
	if (t.center === void 0 && t.defaultZoom === void 0 && t.labelAnchor === void 0 && t.labelScale === void 0) throw Error("CountryPresentationOverride requires at least one manual value");
	let n = {
		policyVersion: N(t.policyVersion, "policyVersion"),
		reason: N(t.reason, "reason")
	};
	return t.center !== void 0 && (n.center = ie(t.center, "center")), t.defaultZoom !== void 0 && (n.defaultZoom = ae(t.defaultZoom, "defaultZoom")), t.labelAnchor !== void 0 && (n.labelAnchor = ie(t.labelAnchor, "labelAnchor")), t.labelScale !== void 0 && (n.labelScale = ae(t.labelScale, "labelScale")), Object.freeze(n);
}
//#endregion
//#region src/lib/world/country-entity.ts
var se = [
	"sovereign",
	"dependent",
	"disputed",
	"unrecognized"
], ce = [
	"id",
	"moduleVersions",
	"names",
	"politicalStatus",
	"presentationOverride"
], le = (e, t, n) => {
	let r = Object.keys(e).sort();
	if (r.length !== t.length || r.some((e, n) => e !== t[n])) throw Error(`${n} contains unknown or missing fields`);
}, ue = (e) => {
	if (typeof e != "string" || !m.test(e)) throw Error("CountryEntity.id must be exactly 3 uppercase alphanumeric characters and start with a letter");
	return e;
}, de = (e) => {
	if (!e || typeof e != "object" || Array.isArray(e)) throw Error("CountryEntity.moduleVersions must be an object record");
	let t = {};
	for (let [n, r] of Object.entries(e)) {
		if (n.trim().length === 0 || !Number.isSafeInteger(r) || r < 0) throw Error(`Invalid module version for ${n || "<empty>"}`);
		t[n] = r;
	}
	return Object.freeze(t);
};
function fe(e) {
	if (!e || typeof e != "object" || Array.isArray(e)) throw Error("CountryEntity must be an object");
	le(e, ce, "CountryEntity");
	let t = e;
	if (typeof t.politicalStatus != "string" || !se.includes(t.politicalStatus)) throw Error("CountryEntity.politicalStatus is invalid");
	return Object.freeze({
		id: ue(t.id),
		names: ne(t.names),
		politicalStatus: t.politicalStatus,
		presentationOverride: t.presentationOverride === null ? null : oe(t.presentationOverride),
		moduleVersions: de(t.moduleVersions)
	});
}
//#endregion
//#region src/lib/world/country-entity-v3.ts
function P(e) {
	if (typeof e != "string" || !/^#[0-9A-F]{6}$/.test(e)) throw Error("CountryEntityV3.mapColor must be canonical uppercase #RRGGBB");
	return e;
}
function pe(e) {
	C(e, "CountryEntityV3");
	let t = b(e, "CountryEntityV3");
	x(t, [
		"id",
		"names",
		"politicalStatus",
		"presentationOverride",
		"moduleVersions",
		"mapColor"
	], "CountryEntityV3");
	let { mapColor: n, ...r } = t;
	return Object.freeze({
		...fe(r),
		mapColor: P(n)
	});
}
//#endregion
//#region src/lib/world/territory-entity-v3.ts
function me(e) {
	let t = b(e, "TerritoryEntityV3");
	x(t, [
		"id",
		"sourceCountryId",
		"ownerCountryId",
		"controllerCountryId"
	], "TerritoryEntityV3");
	let n = t.ownerCountryId === null ? null : w(t.ownerCountryId, "ownerCountryId"), r = t.controllerCountryId === null ? null : w(t.controllerCountryId, "controllerCountryId");
	if (n !== null && r === null) throw Error("An owned territory must have an active controller");
	return Object.freeze({
		id: O(t.id),
		sourceCountryId: w(t.sourceCountryId, "sourceCountryId"),
		ownerCountryId: n,
		controllerCountryId: r
	});
}
var he = /* @__PURE__ */ new WeakSet();
function F(e, t) {
	return j(e.catalogRef, t.ref), he.has(e);
}
function ge(e, t, n) {
	let r = b(e, "WorldStateV3");
	if (x(r, [
		"schemaVersion",
		"seedVersion",
		"policyVersion",
		"revision",
		"countriesById",
		"countryOrder",
		"retiredCountryIds",
		"territoriesById",
		"territoryOrder",
		"catalogRef"
	], "WorldStateV3"), r.schemaVersion !== 3) throw Error("WorldStateV3.schemaVersion must be 3");
	if (typeof r.revision != "number" || !Number.isSafeInteger(r.revision) || r.revision < 0) throw Error("WorldStateV3.revision must be a non-negative safe integer");
	let i = k(r.catalogRef);
	j(i, t.ref);
	let a = E(r.countryOrder, w, "countryOrder"), o = r.retiredCountryIds;
	if (!n && !(o instanceof Set) && (!o || typeof o != "object" || typeof o[Symbol.iterator] != "function" || typeof o.has != "function")) throw Error("WorldStateV3.retiredCountryIds must be a readonly set");
	let s = E(n ? o : [...o], w, "retiredCountryIds");
	v({
		activeCountryIds: a,
		retiredCountryIds: s
	});
	let c = b(r.countriesById, "countriesById");
	D(c, a, "countriesById");
	let l = {};
	for (let e of a) {
		let t = pe(c[e]);
		if (t.id !== e) throw Error("Country record key must match entity id");
		l[e] = t;
	}
	let u = E(r.territoryOrder, O, "territoryOrder");
	if (u.length !== t.territoryOrder.length || u.some((e, n) => e !== t.territoryOrder[n])) throw Error("WorldStateV3.territoryOrder must equal the entire catalog order");
	let d = b(r.territoriesById, "territoriesById");
	D(d, u, "territoriesById");
	let f = {};
	for (let e of u) {
		let n = me(d[e]);
		if (n.id !== e) throw Error("Territory record key must match entity id");
		if (n.sourceCountryId !== t.territoriesById[e].sourceCountryId) throw Error("Territory source-country coverage does not match the catalog");
		for (let e of ["ownerCountryId", "controllerCountryId"]) {
			let t = n[e];
			if (t !== null && !Object.hasOwn(l, t)) throw Error(`Territory ${e} must reference an active country: ${t}`);
		}
		f[e] = n;
	}
	return Object.freeze({
		schemaVersion: 3,
		seedVersion: T(r.seedVersion, "seedVersion"),
		policyVersion: T(r.policyVersion, "policyVersion"),
		revision: r.revision,
		countriesById: Object.freeze(l),
		countryOrder: a,
		retiredCountryIds: p(s),
		territoriesById: Object.freeze(f),
		territoryOrder: u,
		catalogRef: i
	});
}
function _e(e, t) {
	let n = ge(e, A(t), !1);
	return he.add(n), n;
}
//#endregion
//#region src/lib/projection/country-search-index-patch.ts
var ve = (e) => Object.freeze({
	countryId: e.countryId,
	shortKo: e.shortKo,
	officialKo: e.officialKo,
	mapKo: e.mapKo,
	english: e.english,
	searchAliases: Object.freeze([...e.searchAliases]),
	playable: e.playable
}), ye = (e) => ve({
	countryId: e.id,
	shortKo: e.names.shortKo,
	officialKo: e.names.officialKo,
	mapKo: e.names.mapKo,
	english: e.names.english,
	searchAliases: e.names.searchAliases,
	playable: e.politicalStatus === "sovereign"
});
function be(e, t = 0) {
	return Object.freeze({
		revision: e.revision,
		entriesById: new Map(Object.values(e.countriesById).map((e) => [e.id, ye(e)])),
		fullRebuildCount: t
	});
}
//#endregion
//#region src/lib/projection/country-panel-projection.ts
var xe = (e) => e;
Object.freeze({
	revision: 0,
	appliedRevision: 0,
	coreById: /* @__PURE__ */ new Map(),
	inputById: /* @__PURE__ */ new Map(),
	playableById: /* @__PURE__ */ new Map()
});
function Se(e, t, n) {
	if (t.revision !== e.revision) throw Error(`Country panel capital projection revision ${t.revision} does not match state revision ${e.revision}`);
	let r = /* @__PURE__ */ new Map(), i = /* @__PURE__ */ new Map(), a = /* @__PURE__ */ new Map();
	for (let o of e.countryOrder) {
		let s = e.countriesById[o], c = n[o], l = t.featuresByCountryId.get(o);
		r.set(o, Object.freeze({
			countryId: o,
			iso3: c?.iso3 ?? o
		})), i.set(o, Object.freeze({
			nameKo: s.names.shortKo,
			nameEn: s.names.english,
			capitalKo: l?.properties.nameKo ?? "??",
			capitalEn: l?.properties.nameEn ?? "??",
			flagCode: c?.flagCode ?? o,
			region: c?.region ?? ""
		})), a.set(o, s.politicalStatus === "sovereign");
	}
	return Object.freeze({
		revision: e.revision,
		appliedRevision: e.revision,
		coreById: r,
		inputById: i,
		playableById: a
	});
}
function Ce(e, t) {
	if (t === null) return null;
	let n = xe(t), r = e.coreById.get(n), i = e.inputById.get(n), a = e.playableById.get(n);
	return r && i && a !== void 0 ? Object.freeze({
		...r,
		...i,
		playable: a
	}) : null;
}
//#endregion
//#region src/lib/projection/label-projection-checkpoint.ts
function we(e) {
	let t = /* @__PURE__ */ new Map();
	for (let n of e.jobs) t.set(n.jobId, De(n));
	return Object.freeze({
		revision: e.revision,
		appliedRevision: e.revision,
		jobs: e.jobs,
		pointFallbacksByLabelId: t,
		glyphsByLabelId: /* @__PURE__ */ new Map(),
		settled: e.jobs.length === 0
	});
}
Object.freeze({
	coordinatePrecision: 9,
	exteriorRingWinding: "counterclockwise"
});
var Te = (e) => c(i(e)), Ee = (e) => Te({
	namespace: "labelText",
	text: e
});
function De(e) {
	return Object.freeze({
		type: "Feature",
		id: e.jobId,
		properties: Object.freeze({
			countryId: e.countryId,
			territoryId: e.territoryId,
			projectionRevision: e.revision,
			text: e.text,
			renderer: "point-fallback"
		}),
		geometry: Object.freeze({
			type: "Point",
			coordinates: e.anchor
		})
	});
}
//#endregion
//#region src/lib/projection/catalog-map-consumer-projection.ts
var I = "world-territory-catalog", L = /* @__PURE__ */ new WeakMap();
function R(e) {
	let t = L.get(e);
	return t || (t = A({
		ref: e.catalogRef,
		territoryOrder: e.territories.map((e) => e.id),
		territoriesById: Object.fromEntries(e.territories.map((e) => [e.id, {
			id: e.id,
			sourceCountryId: e.sourceCountryId
		}]))
	}), L.set(e, t)), t;
}
function Oe(e) {
	return {
		sourceType: "vector",
		sourceId: I,
		sourceLayer: "territories",
		featureId: e
	};
}
function z(e, t, n) {
	j(e.catalogRef, t.catalogRef);
	let r = R(t), a = F(e, r) ? e : _e(e, r), o = new Map(t.territories.map((e) => [e.id, e])), s = n ? a.countryOrder.filter((e) => n.countryIds.includes(e)) : a.countryOrder, l = n?.territoryIds ?? a.territoryOrder, u = {}, d = {}, f = {};
	for (let e of s) u[e] = [], d[e] = [], f[e] = [];
	let p = {};
	for (let e of l) {
		let t = a.territoriesById[e], n = t.ownerCountryId ?? t.controllerCountryId;
		t.ownerCountryId && d[t.ownerCountryId]?.push(e), t.controllerCountryId && f[t.controllerCountryId]?.push(e), n && u[n]?.push(e), p[e] = {
			ref: Oe(e),
			ownerCountryId: t.ownerCountryId,
			controllerCountryId: t.controllerCountryId,
			countryId: n,
			mapColor: t.controllerCountryId ?? t.ownerCountryId ? a.countriesById[t.controllerCountryId ?? t.ownerCountryId].mapColor : "#D6D3C7",
			occupied: t.controllerCountryId !== null && t.controllerCountryId !== t.ownerCountryId
		};
	}
	let m = new Map(t.countries.map((e) => [e.countryId, e])), h = {}, g = [];
	for (let e of s) {
		let n = u[e], r = a.countriesById[e], s = m.get(e), l = r.presentationOverride, d = n.map((e) => o.get(e)).sort((e, t) => t.area - e.area || (e.id < t.id ? -1 : 1))[0];
		if (!d) continue;
		let f = l?.labelAnchor ?? (s && n.includes(s.label.territoryId) ? s.label.anchor : d.anchor), p = n.reduce((e, t) => {
			let n = o.get(t).bbox;
			return [
				Math.min(e[0], n[0]),
				Math.min(e[1], n[1]),
				Math.max(e[2], n[2]),
				Math.max(e[3], n[3])
			];
		}, [
			Infinity,
			Infinity,
			-Infinity,
			-Infinity
		]), _ = Math.max(p[2] - p[0], p[3] - p[1]);
		h[e] = {
			center: l?.center ?? f,
			zoom: l?.defaultZoom ?? Math.max(1, Math.min(7, Math.log2(360 / Math.max(1, _))))
		};
		let v = s && n.includes(s.label.territoryId) ? s.label.territoryId : d.id;
		g.push({
			jobId: `catalog-label:${e}`,
			revision: a.revision,
			countryId: e,
			territoryId: v,
			text: r.names.mapKo,
			anchor: f,
			priority: -d.area,
			hashes: {
				territoryGeometryHash: c(i({
					geometryRoot: t.catalogRef.geometryRoot,
					territoryIds: n,
					anchor: f
				})),
				textHash: Ee(r.names.mapKo),
				fontHash: "font:runtime-default",
				policyHash: "catalog-country-label-v1"
			}
		});
	}
	let _ = [], v = {};
	for (let e of t.countries) {
		if (!s.includes(e.countryId)) continue;
		v[e.countryId] = {
			countryId: e.countryId,
			iso3: e.iso3,
			flagCode: e.flagCode,
			region: e.region
		};
		let t = e.capital;
		t && a.countriesById[e.countryId] && a.territoriesById[t.territoryId]?.ownerCountryId === e.countryId && _.push({
			type: "Feature",
			id: e.countryId,
			properties: {
				countryId: e.countryId,
				territoryId: t.territoryId,
				nameKo: t.nameKo,
				nameEn: t.nameEn,
				capitalType: t.capitalType,
				labelRank: t.labelRank
			},
			geometry: {
				type: "Point",
				coordinates: t.coordinates
			}
		});
	}
	let y = {
		revision: a.revision,
		appliedRevision: a.revision,
		features: _,
		featuresByCountryId: new Map(_.map((e) => [e.id, e])),
		omittedCountryIds: s.filter((e) => !_.some((t) => t.id === e))
	}, b = {
		...a,
		countryOrder: s,
		countriesById: Object.fromEntries(s.map((e) => [e, a.countriesById[e]]))
	}, x = Se(b, y, v), S = be(b), C = we({
		revision: a.revision,
		jobs: g
	});
	return Object.freeze({
		catalogRef: t.catalogRef,
		appliedRevision: a.revision,
		world: a,
		metadata: t,
		featuresById: p,
		territoryById: o,
		presentedByCountry: u,
		ownedByCountry: d,
		controlledByCountry: f,
		focusByCountryId: h,
		labels: C,
		capitals: y,
		panel: x,
		search: S,
		projectionStats: {
			fullBuilds: +!n,
			countryRebuilds: s.length,
			territoryRebuilds: l.length
		}
	});
}
function ke(e, t) {
	j(e.catalogRef, t.catalogRef);
	let n = R(e.metadata), i = F(t, n) ? t : _e(t, n), a = new Set([...e.world.countryOrder, ...i.countryOrder].filter((t) => {
		let n = e.world.countriesById[t], a = i.countriesById[t];
		return n !== a && (!n || !a || r(n) !== r(a));
	})), o = i.territoryOrder.filter((t) => {
		let n = e.world.territoriesById[t], r = i.territoriesById[t];
		return n.ownerCountryId !== r.ownerCountryId || n.controllerCountryId !== r.controllerCountryId;
	}), s = new Set(o), c = new Set(a), l = {
		presentedByCountry: { ...e.presentedByCountry },
		ownedByCountry: { ...e.ownedByCountry },
		controlledByCountry: { ...e.controlledByCountry }
	};
	for (let t of a) for (let n of [...e.ownedByCountry[t] ?? [], ...e.controlledByCountry[t] ?? []]) s.add(n);
	let u = (e, t, n, r) => {
		n !== r && (n && (e[n] = (e[n] ?? []).filter((e) => e !== t)), r && (e[r] = [...e[r] ?? [], t].sort()));
	};
	for (let t of o) {
		let n = e.world.territoriesById[t], r = i.territoriesById[t];
		u(l.ownedByCountry, t, n.ownerCountryId, r.ownerCountryId), u(l.controlledByCountry, t, n.controllerCountryId, r.controllerCountryId);
		let a = n.ownerCountryId ?? n.controllerCountryId, o = r.ownerCountryId ?? r.controllerCountryId;
		u(l.presentedByCountry, t, a, o), a !== o && (a && c.add(a), o && c.add(o)), n.ownerCountryId !== r.ownerCountryId && (n.ownerCountryId && c.add(n.ownerCountryId), r.ownerCountryId && c.add(r.ownerCountryId));
	}
	for (let e of a) for (let t of Object.values(l)) i.countriesById[e] ? t[e] ??= [] : delete t[e];
	let d = { ...e.featuresById }, f = [];
	for (let e of [...s].sort()) {
		let t = i.territoriesById[e], n = d[e], r = t.controllerCountryId ?? t.ownerCountryId, a = {
			...n,
			ownerCountryId: t.ownerCountryId,
			controllerCountryId: t.controllerCountryId,
			countryId: t.ownerCountryId ?? t.controllerCountryId,
			mapColor: r ? i.countriesById[r].mapColor : "#D6D3C7",
			occupied: t.controllerCountryId !== null && t.controllerCountryId !== t.ownerCountryId
		};
		(n.ownerCountryId !== a.ownerCountryId || n.controllerCountryId !== a.controllerCountryId || n.mapColor !== a.mapColor) && (d[e] = a, f.push(e));
	}
	let p = [...c].sort(), m = [...new Set(p.flatMap((e) => l.presentedByCountry[e] ?? []))].sort(), h = z(i, e.metadata, {
		countryIds: p,
		territoryIds: m
	}), g = (e, t, n) => {
		let r = new Map(e);
		for (let e of p) r.delete(n(e));
		for (let [e, n] of t) r.set(e, n);
		return r;
	}, _ = g(e.labels.pointFallbacksByLabelId, h.labels.pointFallbacksByLabelId, (e) => `catalog-label:${e}`), v = [...e.labels.jobs.filter((e) => !c.has(e.countryId)), ...h.labels.jobs].sort((e, t) => e.countryId < t.countryId ? -1 : 1), y = {
		...e.labels,
		revision: i.revision,
		appliedRevision: i.revision,
		pointFallbacksByLabelId: _,
		jobs: v
	}, b = g(e.capitals.featuresByCountryId, h.capitals.featuresByCountryId, (e) => e), x = {
		...e.capitals,
		revision: i.revision,
		appliedRevision: i.revision,
		featuresByCountryId: b,
		features: [...b.values()].sort((e, t) => e.id < t.id ? -1 : 1),
		omittedCountryIds: i.countryOrder.filter((e) => !b.has(e))
	}, S = {
		...e.panel,
		revision: i.revision,
		appliedRevision: i.revision,
		coreById: g(e.panel.coreById, h.panel.coreById, (e) => e),
		inputById: g(e.panel.inputById, h.panel.inputById, (e) => e),
		playableById: g(e.panel.playableById, h.panel.playableById, (e) => e)
	}, C = {
		...e.search,
		revision: i.revision,
		entriesById: g(e.search.entriesById, h.search.entriesById, (e) => e)
	}, w = { ...e.focusByCountryId };
	for (let e of p) delete w[e];
	return Object.assign(w, h.focusByCountryId), Object.freeze({
		projection: Object.freeze({
			...e,
			world: i,
			appliedRevision: i.revision,
			featuresById: d,
			...l,
			labels: y,
			capitals: x,
			panel: S,
			search: C,
			focusByCountryId: w,
			projectionStats: {
				fullBuilds: e.projectionStats.fullBuilds,
				countryRebuilds: e.projectionStats.countryRebuilds + p.length,
				territoryRebuilds: e.projectionStats.territoryRebuilds + s.size
			}
		}),
		changedFeatureIds: f,
		changedCountryIds: [...a].sort()
	});
}
function Ae(e, t) {
	let n = Ce(e.panel, t);
	return n ? Object.freeze({
		...n,
		catalogRef: e.catalogRef,
		ownedTerritoryCount: e.ownedByCountry[n.countryId].length,
		controlledTerritoryCount: e.controlledByCountry[n.countryId].length
	}) : null;
}
function B(e, t) {
	if (t.source !== "world-territory-catalog" || t.sourceLayer !== "territories" || typeof t.id != "string" || t.properties?.territoryId !== t.id) return null;
	let n = e.featuresById[t.id];
	return n ? {
		territoryId: t.id,
		countryId: n.countryId,
		ownerCountryId: n.ownerCountryId,
		controllerCountryId: n.controllerCountryId
	} : null;
}
//#endregion
//#region src/lib/map/render-feature-ref.ts
function je(e) {
	if (!e.sourceId || !e.featureId) throw Error("Invalid render feature reference");
	if (e.sourceType === "vector") {
		if (!["territories", "edges"].includes(e.sourceLayer)) throw Error("Invalid vector source layer");
		return {
			source: e.sourceId,
			sourceLayer: e.sourceLayer,
			id: e.featureId
		};
	}
	if (e.sourceType !== "geojson") throw Error("Unknown render source type");
	return {
		source: e.sourceId,
		id: e.featureId
	};
}
//#endregion
//#region src/lib/map/map-config.ts
var V = {
	countriesLow: "countries-low",
	countriesHigh: "countries-high",
	bordersLow: "borders-low",
	bordersHigh: "borders-high",
	admin1: "admin1",
	labels: "country-label-placements",
	glyphLabelFills: "country-label-glyph-fills",
	glyphLabelOutlines: "country-label-glyph-outlines",
	capitals: "capitals",
	smallCountries: "small-countries",
	wars: "war-overlay-slot"
};
V.countriesLow, V.bordersLow, V.countriesHigh, V.bordersHigh;
var Me = class extends Error {
	constructor(e) {
		super(e), this.name = "MapSourceSyncError";
	}
};
function H(e, t) {
	let n = /* @__PURE__ */ new Set();
	for (let r of e.features) {
		if (typeof r.id != "string" || !r.id || n.has(r.id)) throw new Me(`Invalid or duplicate feature ID in ${t}: ${String(r.id)}`);
		n.add(r.id);
	}
}
function Ne(e, t, n) {
	H(e, n), H(t, n);
	let i = new Map(e.features.map((e) => [e.id, e])), a = new Map(t.features.map((e) => [e.id, e])), o = e.features.filter((e) => !a.has(e.id)).map((e) => e.id), s = t.features.filter((e) => !i.has(e.id)), c = [];
	for (let e of t.features) {
		let t = i.get(e.id);
		if (!t || t === e) continue;
		let n = t.geometry !== e.geometry && r(t.geometry) !== r(e.geometry), a = t.properties !== e.properties && r(t.properties) !== r(e.properties);
		!n && !a || c.push({
			id: e.id,
			...n ? { newGeometry: e.geometry } : {},
			...a ? {
				removeAllProperties: !0,
				addOrUpdateProperties: Object.entries(e.properties).map(([e, t]) => ({
					key: e,
					value: t
				}))
			} : {}
		});
	}
	let l = {};
	return o.length && (l.remove = o), s.length && (l.add = s), c.length && (l.update = c), {
		diff: l,
		changedIds: [
			...o,
			...s.map((e) => e.id),
			...c.map((e) => String(e.id))
		]
	};
}
//#endregion
//#region node_modules/@mapbox/point-geometry/index.js
function U(e, t) {
	this.x = e, this.y = t;
}
U.prototype = {
	clone() {
		return new U(this.x, this.y);
	},
	add(e) {
		return this.clone()._add(e);
	},
	sub(e) {
		return this.clone()._sub(e);
	},
	multByPoint(e) {
		return this.clone()._multByPoint(e);
	},
	divByPoint(e) {
		return this.clone()._divByPoint(e);
	},
	mult(e) {
		return this.clone()._mult(e);
	},
	div(e) {
		return this.clone()._div(e);
	},
	rotate(e) {
		return this.clone()._rotate(e);
	},
	rotateAround(e, t) {
		return this.clone()._rotateAround(e, t);
	},
	matMult(e) {
		return this.clone()._matMult(e);
	},
	unit() {
		return this.clone()._unit();
	},
	perp() {
		return this.clone()._perp();
	},
	round() {
		return this.clone()._round();
	},
	mag() {
		return Math.sqrt(this.x * this.x + this.y * this.y);
	},
	equals(e) {
		return this.x === e.x && this.y === e.y;
	},
	dist(e) {
		return Math.sqrt(this.distSqr(e));
	},
	distSqr(e) {
		let t = e.x - this.x, n = e.y - this.y;
		return t * t + n * n;
	},
	angle() {
		return Math.atan2(this.y, this.x);
	},
	angleTo(e) {
		return Math.atan2(this.y - e.y, this.x - e.x);
	},
	angleWith(e) {
		return this.angleWithSep(e.x, e.y);
	},
	angleWithSep(e, t) {
		return Math.atan2(this.x * t - this.y * e, this.x * e + this.y * t);
	},
	_matMult(e) {
		let t = e[0] * this.x + e[1] * this.y, n = e[2] * this.x + e[3] * this.y;
		return this.x = t, this.y = n, this;
	},
	_add(e) {
		return this.x += e.x, this.y += e.y, this;
	},
	_sub(e) {
		return this.x -= e.x, this.y -= e.y, this;
	},
	_mult(e) {
		return this.x *= e, this.y *= e, this;
	},
	_div(e) {
		return this.x /= e, this.y /= e, this;
	},
	_multByPoint(e) {
		return this.x *= e.x, this.y *= e.y, this;
	},
	_divByPoint(e) {
		return this.x /= e.x, this.y /= e.y, this;
	},
	_unit() {
		return this._div(this.mag()), this;
	},
	_perp() {
		let e = this.y;
		return this.y = this.x, this.x = -e, this;
	},
	_rotate(e) {
		let t = Math.cos(e), n = Math.sin(e), r = t * this.x - n * this.y, i = n * this.x + t * this.y;
		return this.x = r, this.y = i, this;
	},
	_rotateAround(e, t) {
		let n = Math.cos(e), r = Math.sin(e), i = t.x + n * (this.x - t.x) - r * (this.y - t.y), a = t.y + r * (this.x - t.x) + n * (this.y - t.y);
		return this.x = i, this.y = a, this;
	},
	_round() {
		return this.x = Math.round(this.x), this.y = Math.round(this.y), this;
	},
	constructor: U
}, U.convert = function(e) {
	if (e instanceof U) return e;
	if (Array.isArray(e)) return new U(+e[0], +e[1]);
	if (e.x !== void 0 && e.y !== void 0) return new U(+e.x, +e.y);
	throw Error("Expected [x, y] or {x, y} point format");
};
//#endregion
//#region node_modules/@mapbox/vector-tile/index.js
var W = class {
	constructor(e, t, n, r, i) {
		for (this.properties = Object.create(null), this.extent = n, this.type = 0, this.id = void 0, this._pbf = e, this._geometry = -1, this._keys = r, this._values = i; e.pos < t;) {
			let t = e.readVarint();
			if (t === 8) this.id = e.readVarint();
			else if (t === 18) {
				let t = e.readVarint() + e.pos;
				for (; e.pos < t;) {
					let t = r[e.readVarint()], n = i[e.readVarint()];
					this.properties[t] = n;
				}
			} else t === 24 ? this.type = e.readVarint() : (t === 34 && (this._geometry = e.pos), e.skip(t));
		}
	}
	loadGeometry() {
		if (this._geometry < 0) throw Error("feature has no geometry");
		let e = this._pbf;
		e.pos = this._geometry;
		let t = e.readVarint() + e.pos, n = [], r, i = 1, a = 0, o = 0, s = 0;
		for (; e.pos < t;) {
			if (a <= 0) {
				let t = e.readVarint();
				if (i = t & 7, a = t >> 3, a === 0) continue;
			}
			if (a--, i === 1) o += e.readSVarint(), s += e.readSVarint(), r && n.push(r), r = [new U(o, s)];
			else if (i === 2) o += e.readSVarint(), s += e.readSVarint(), r && r.push(new U(o, s));
			else if (i === 7) r && r.push(r[0].clone());
			else throw Error(`unknown command ${i}`);
		}
		return r && n.push(r), n;
	}
	bbox() {
		if (this._geometry < 0) throw Error("feature has no geometry");
		let e = this._pbf;
		e.pos = this._geometry;
		let t = e.readVarint() + e.pos, n = 1, r = 0, i = 0, a = 0, o = Infinity, s = -Infinity, c = Infinity, l = -Infinity;
		for (; e.pos < t;) {
			if (r <= 0) {
				let t = e.readVarint();
				if (n = t & 7, r = t >> 3, r === 0) continue;
			}
			if (r--, n === 1 || n === 2) i += e.readSVarint(), a += e.readSVarint(), i < o && (o = i), i > s && (s = i), a < c && (c = a), a > l && (l = a);
			else if (n !== 7) throw Error(`unknown command ${n}`);
		}
		return [
			o,
			c,
			s,
			l
		];
	}
	toGeoJSON(e, t, n) {
		let r = this.extent * 2 ** n, i = this.extent * e, a = this.extent * t, o = this.loadGeometry();
		function s(e) {
			return [(e.x + i) * 360 / r - 180, 360 / Math.PI * Math.atan(Math.exp((1 - (e.y + a) * 2 / r) * Math.PI)) - 90];
		}
		function c(e) {
			return e.map(s);
		}
		let l;
		if (this.type === 1) {
			let e = [];
			for (let t of o) e.push(t[0]);
			let t = c(e);
			l = e.length === 1 ? {
				type: "Point",
				coordinates: t[0]
			} : {
				type: "MultiPoint",
				coordinates: t
			};
		} else if (this.type === 2) {
			let e = o.map(c);
			l = e.length === 1 ? {
				type: "LineString",
				coordinates: e[0]
			} : {
				type: "MultiLineString",
				coordinates: e
			};
		} else if (this.type === 3) {
			let e = Pe(o), t = [];
			for (let n of e) t.push(n.map(c));
			l = t.length === 1 ? {
				type: "Polygon",
				coordinates: t[0]
			} : {
				type: "MultiPolygon",
				coordinates: t
			};
		} else throw Error("unknown feature type");
		let u = {
			type: "Feature",
			geometry: l,
			properties: this.properties
		};
		return this.id != null && (u.id = this.id), u;
	}
};
W.types = [
	"Unknown",
	"Point",
	"LineString",
	"Polygon"
];
function Pe(e) {
	let t = e.length;
	if (t <= 1) return [e];
	let n = [], r, i;
	for (let a = 0; a < t; a++) {
		let t = Fe(e[a]);
		t !== 0 && (i === void 0 && (i = t < 0), i === t < 0 ? (r && n.push(r), r = [e[a]]) : r && r.push(e[a]));
	}
	return r && n.push(r), n;
}
function Fe(e) {
	let t = 0;
	for (let n = 0, r = e.length, i = r - 1, a, o; n < r; i = n++) a = e[n], o = e[i], t += (o.x - a.x) * (a.y + o.y);
	return t;
}
var Ie = class {
	constructor(e, t) {
		for (this.version = 1, this.name = "", this.extent = 4096, this.length = 0, this._pbf = e, this._keys = [], this._values = [], this._features = [], t === void 0 && (t = e.length); e.pos < t;) {
			let t = e.readVarint();
			t === 10 ? this.name = e.readString() : t === 18 ? (this._features.push(e.pos), e.skip(t)) : t === 26 ? this._keys.push(e.readString()) : t === 34 ? this._values.push(Le(e)) : t === 40 ? this.extent = e.readVarint() : t === 120 ? this.version = e.readVarint() : e.skip(t);
		}
		this.length = this._features.length;
	}
	feature(e) {
		if (e < 0 || e >= this._features.length) throw Error("feature index out of bounds");
		this._pbf.pos = this._features[e];
		let t = this._pbf.readVarint() + this._pbf.pos;
		return new W(this._pbf, t, this.extent, this._keys, this._values);
	}
};
function Le(e) {
	let t = null, n = e.readVarint() + e.pos;
	for (; e.pos < n;) {
		let n = e.readVarint();
		t = n === 10 ? e.readString() : n === 21 ? e.readFloat() : n === 25 ? e.readDouble() : n === 32 ? e.readVarint64() : n === 40 ? e.readVarint() : n === 48 ? e.readSVarint() : n === 56 ? e.readBoolean() : (e.skip(n), null);
	}
	if (t == null) throw Error("unknown feature value");
	return t;
}
var Re = class {
	constructor(e, t = e.length) {
		let n = Object.create(null);
		for (; e.pos < t;) {
			let t = e.readVarint();
			if (t === 26) {
				let t = new Ie(e, e.readVarint() + e.pos);
				t.length && (n[t.name] = t);
			} else e.skip(t);
		}
		this.layers = n;
	}
}, G = 4294967296;
1 / G;
var ze = 12, Be = typeof TextDecoder > "u" ? null : new TextDecoder("utf-8"), Ve = 0, He = 1, Ue = 2, We = 5, Ge = class {
	constructor(e) {
		this.buf = ArrayBuffer.isView(e) ? e : new Uint8Array(e), this.dataView = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength), this.pos = 0, this.type = 0, this._valueStart = -1, this.length = this.buf.length;
	}
	readFields(e, t, n = this.length) {
		let r;
		for (; r = this.nextField(n);) e(r, t, this);
		return t;
	}
	readMessage(e, t) {
		return this.readFields(e, t, this.readVarint() + this.pos);
	}
	readFixed32() {
		let e = this.dataView.getUint32(this.pos, !0);
		return this.pos += 4, e;
	}
	readSFixed32() {
		let e = this.dataView.getInt32(this.pos, !0);
		return this.pos += 4, e;
	}
	readFixed64() {
		let e = this.dataView.getUint32(this.pos, !0) + this.dataView.getUint32(this.pos + 4, !0) * G;
		return this.pos += 8, e;
	}
	readSFixed64() {
		let e = this.dataView.getUint32(this.pos, !0) + this.dataView.getInt32(this.pos + 4, !0) * G;
		return this.pos += 8, e;
	}
	readFloat() {
		let e = this.dataView.getFloat32(this.pos, !0);
		return this.pos += 4, e;
	}
	readDouble() {
		let e = this.dataView.getFloat64(this.pos, !0);
		return this.pos += 8, e;
	}
	readVarint(e) {
		let t = this.buf, n = t[this.pos++];
		if (n < 128) return n;
		let r = n & 127, i;
		return i = t[this.pos++], r |= (i & 127) << 7, i < 128 || (i = t[this.pos++], r |= (i & 127) << 14, i < 128) || (i = t[this.pos++], r |= (i & 127) << 21, i < 128) ? r : (i = t[this.pos], r |= (i & 15) << 28, Ke(r, e, this));
	}
	readSVarint() {
		let e = this.readVarint();
		return e % 2 == 1 ? (e + 1) / -2 : e / 2;
	}
	readBoolean() {
		return !!this.readVarint();
	}
	readString() {
		let e = this.readVarint() + this.pos, t = this.pos;
		return this.pos = e, e - t >= ze && Be ? Be.decode(this.buf.subarray(t, e)) : Je(this.buf, t, e);
	}
	readBytes() {
		let e = this.readVarint() + this.pos, t = this.buf.subarray(this.pos, e);
		return this.pos = e, t;
	}
	readPackedVarint(e = [], t) {
		let n = this.readPackedEnd();
		for (; this.pos < n;) e.push(this.readVarint(t));
		return e;
	}
	readPackedSVarint(e = []) {
		let t = this.readPackedEnd();
		for (; this.pos < t;) e.push(this.readSVarint());
		return e;
	}
	readPackedBoolean(e = []) {
		let t = this.readPackedEnd();
		for (; this.pos < t;) e.push(this.readBoolean());
		return e;
	}
	readPackedFloat(e = []) {
		let t = this.readPackedEnd();
		for (; this.pos < t;) e.push(this.readFloat());
		return e;
	}
	readPackedDouble(e = []) {
		let t = this.readPackedEnd();
		for (; this.pos < t;) e.push(this.readDouble());
		return e;
	}
	readPackedFixed32(e = []) {
		let t = this.readPackedEnd();
		for (; this.pos < t;) e.push(this.readFixed32());
		return e;
	}
	readPackedSFixed32(e = []) {
		let t = this.readPackedEnd();
		for (; this.pos < t;) e.push(this.readSFixed32());
		return e;
	}
	readPackedFixed64(e = []) {
		let t = this.readPackedEnd();
		for (; this.pos < t;) e.push(this.readFixed64());
		return e;
	}
	readPackedSFixed64(e = []) {
		let t = this.readPackedEnd();
		for (; this.pos < t;) e.push(this.readSFixed64());
		return e;
	}
	readPackedEnd() {
		return this.type === Ue ? this.readVarint() + this.pos : this.pos + 1;
	}
	nextField(e = this.length) {
		if (this.pos === this._valueStart && this.skip(this.type), this.pos >= e) return 0;
		let t = this.readVarint();
		return this.type = t & 7, this._valueStart = this.pos, t >>> 3;
	}
	skip(e) {
		let t = e & 7;
		if (t === Ve) for (; this.buf[this.pos++] > 127;);
		else if (t === Ue) this.pos = this.readVarint() + this.pos;
		else if (t === We) this.pos += 4;
		else if (t === He) this.pos += 8;
		else throw Error(`Unimplemented type: ${t}`);
	}
};
function Ke(e, t, n) {
	let r = n.buf, i, a;
	if (a = r[n.pos++], i = (a & 112) >> 4, a < 128 || (a = r[n.pos++], i |= (a & 127) << 3, a < 128) || (a = r[n.pos++], i |= (a & 127) << 10, a < 128) || (a = r[n.pos++], i |= (a & 127) << 17, a < 128) || (a = r[n.pos++], i |= (a & 127) << 24, a < 128) || (a = r[n.pos++], i |= (a & 1) << 31, a < 128)) return qe(e, i, t);
	throw Error("Expected varint not more than 10 bytes");
}
function qe(e, t, n) {
	return n ? t * 4294967296 + (e >>> 0) : (t >>> 0) * 4294967296 + (e >>> 0);
}
function Je(e, t, n) {
	let r = "", i = t;
	for (; i < n;) {
		let t = e[i], a = null, o = t > 239 ? 4 : t > 223 ? 3 : t > 191 ? 2 : 1;
		if (i + o > n) break;
		let s, c, l;
		o === 1 ? t < 128 && (a = t) : o === 2 ? (s = e[i + 1], (s & 192) == 128 && (a = (t & 31) << 6 | s & 63, a <= 127 && (a = null))) : o === 3 ? (s = e[i + 1], c = e[i + 2], (s & 192) == 128 && (c & 192) == 128 && (a = (t & 15) << 12 | (s & 63) << 6 | c & 63, (a <= 2047 || a >= 55296 && a <= 57343) && (a = null))) : o === 4 && (s = e[i + 1], c = e[i + 2], l = e[i + 3], (s & 192) == 128 && (c & 192) == 128 && (l & 192) == 128 && (a = (t & 15) << 18 | (s & 63) << 12 | (c & 63) << 6 | l & 63, (a <= 65535 || a >= 1114112) && (a = null))), a === null ? (a = 65533, o = 1) : a > 65535 && (a -= 65536, r += String.fromCharCode(a >>> 10 & 1023 | 55296), a = 56320 | a & 1023), r += String.fromCharCode(a), i += o;
	}
	return r;
}
//#endregion
//#region src/lib/map/catalog-consumer-contract.ts
var K = b;
function q(e, t) {
	let n = K(e, "catalog artifact");
	x(n, [
		"path",
		"sha256",
		"byteLength"
	], "catalog artifact");
	let r = `/data/territory-catalog/${t.catalogVersion}/`;
	if (typeof n.path != "string" || !n.path.startsWith(r) || n.path.slice(r.length).split("/").some((e) => !e || !/^[-A-Za-z0-9._]+$/.test(e) || e === "." || e === "..") || !/^([a-f0-9]{64})$/.test(String(n.sha256)) || !Number.isSafeInteger(n.byteLength) || Number(n.byteLength) < 0) throw Error("Invalid versioned catalog artifact identity");
	return Object.freeze({
		path: n.path,
		sha256: n.sha256,
		byteLength: n.byteLength
	});
}
function Ye(e, t) {
	let n = K(e, "catalog bootstrap");
	if (x(n, [
		"schemaVersion",
		"catalogRef",
		"manifest",
		"tileIndex",
		"metadata"
	], "catalog bootstrap"), n.schemaVersion !== "catalog-consumer-bootstrap-v1") throw Error("Invalid catalog bootstrap schema");
	let r = k(n.catalogRef);
	j(r, t);
	let i = q(n.manifest, r), a = q(n.tileIndex, r), o = q(n.metadata, r);
	if (i.path !== r.manifestPath || !a.path.endsWith("/tile-index.json") || !o.path.endsWith("/consumer-metadata.json")) throw Error("Unexpected catalog browser artifact");
	return Object.freeze({
		schemaVersion: "catalog-consumer-bootstrap-v1",
		catalogRef: r,
		manifest: i,
		tileIndex: a,
		metadata: o
	});
}
var J = (e, t) => {
	if (!Array.isArray(e) || e.length !== t || !e.every((e) => typeof e == "number" && Number.isFinite(e))) throw Error("Invalid catalog coordinates");
	return Object.freeze([...e]);
};
function Xe(e, t) {
	let n = K(e, "catalog metadata");
	if (x(n, [
		"schemaVersion",
		"catalogRef",
		"territories",
		"countries"
	], "catalog metadata"), n.schemaVersion !== "catalog-consumer-metadata-v1" || !Array.isArray(n.territories) || !Array.isArray(n.countries)) throw Error("Invalid catalog metadata schema");
	let r = k(n.catalogRef);
	j(r, t);
	let i = n.territories.map((e) => {
		let t = K(e, "territory metadata");
		if (x(t, [
			"id",
			"sourceCountryId",
			"bbox",
			"area",
			"anchor"
		], "territory metadata"), typeof t.area != "number" || !(t.area > 0) || !Number.isFinite(t.area)) throw Error("Invalid territory area");
		let n = J(t.bbox, 4), r = J(t.anchor, 2);
		if (n[0] > n[2] || n[1] > n[3] || n[0] < -180 || n[2] > 180 || n[1] < -90 || n[3] > 90 || r[0] < n[0] || r[0] > n[2] || r[1] < n[1] || r[1] > n[3]) throw Error("Catalog anchor/bbox mismatch");
		return Object.freeze({
			id: O(t.id),
			sourceCountryId: w(t.sourceCountryId, "source country"),
			bbox: n,
			area: t.area,
			anchor: r
		});
	});
	if (i.length > 6e3 || i.some((e, t) => t > 0 && i[t - 1].id >= e.id)) throw Error("Invalid catalog territory order/cap");
	let a = new Map(i.map((e) => [e.id, e])), o = n.countries.map((e) => {
		let t = K(e, "country metadata");
		x(t, [
			"countryId",
			"iso3",
			"flagCode",
			"region",
			"label",
			"capital"
		], "country metadata");
		let n = w(t.countryId, "country metadata");
		if (![
			"iso3",
			"flagCode",
			"region"
		].every((e) => typeof t[e] == "string")) throw Error("Invalid country presentation");
		let r = K(t.label, "label seed");
		x(r, ["territoryId", "anchor"], "label seed");
		let i = O(r.territoryId);
		if (a.get(i)?.sourceCountryId !== n) throw Error("Label seed source mismatch");
		let o = null;
		if (t.capital !== null) {
			let e = K(t.capital, "capital seed");
			x(e, [
				"territoryId",
				"coordinates",
				"countryId",
				"nameKo",
				"nameEn",
				"capitalType",
				"labelRank"
			], "capital seed");
			let r = O(e.territoryId);
			if (a.get(r)?.sourceCountryId !== n || e.countryId !== n || ![
				"nameKo",
				"nameEn",
				"capitalType"
			].every((t) => typeof e[t] == "string") || !Number.isFinite(e.labelRank)) throw Error("Invalid capital seed");
			o = Object.freeze({
				...e,
				territoryId: r,
				coordinates: J(e.coordinates, 2)
			});
		}
		return Object.freeze({
			countryId: n,
			iso3: t.iso3,
			flagCode: t.flagCode,
			region: t.region,
			label: Object.freeze({
				territoryId: i,
				anchor: J(r.anchor, 2)
			}),
			capital: o
		});
	});
	if (o.some((e, t) => t > 0 && o[t - 1].countryId >= e.countryId) || new Set(i.map((e) => e.sourceCountryId)).size !== o.length || i.some((e) => !o.some((t) => t.countryId === e.sourceCountryId))) throw Error("Catalog country coverage/order mismatch");
	return Object.freeze({
		schemaVersion: "catalog-consumer-metadata-v1",
		catalogRef: r,
		territories: Object.freeze(i),
		countries: Object.freeze(o)
	});
}
//#endregion
//#region src/lib/map/catalog-vector-delivery.ts
var Y = new TextDecoder();
async function Ze(e, t, n) {
	if (!e.ok) throw Error(`Catalog asset request failed: ${e.status}`);
	if (e.redirected) throw Error("Catalog asset redirect rejected");
	let r = await e.arrayBuffer();
	if (r.byteLength !== t.byteLength) throw Error("Catalog asset byte length mismatch");
	if (n?.throwIfAborted(), Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", r))).map((e) => e.toString(16).padStart(2, "0")).join("") !== t.sha256) throw Error("Catalog asset SHA-256 mismatch");
	return r;
}
async function Qe(e, t, n = fetch, r) {
	let i = Ye(e, t), a = 0, o = 0, s = async (e, t = r) => {
		let i = await Ze(await n(e.path, {
			signal: t,
			cache: "force-cache",
			redirect: "error"
		}), e, t);
		return a++, i;
	}, c = JSON.parse(Y.decode(await s(i.manifest))), l = JSON.parse(Y.decode(await s(i.tileIndex)));
	j(k(c.ref), t);
	let u = `/data/territory-catalog/${t.catalogVersion}/`, d = `${u}tiles/{z}/{x}/{y}.pbf`;
	if (c.minZoom !== 0 || c.maxZoom !== 6 || c.schemaVersion !== "world-geometry-catalog-v1" || c.sourceId !== "world-territory-catalog" || c.tileTemplate !== d || c.promoteId?.territories !== "territoryId" || c.promoteId?.edges !== "edgeId" || l.renderArtifactRoot !== t.renderArtifactRoot || l.artifacts.length !== 5461) throw Error("Invalid approved vector manifest/tile index");
	let f = /* @__PURE__ */ new Map(), p = 0;
	for (let e = 0; e <= 6; e++) for (let n = 0; n < 2 ** e; n++) for (let r = 0; r < 2 ** e; r++) {
		let i = q({
			...l.artifacts[p],
			path: l.artifacts[p++].path.replace(/^public/, "")
		}, t);
		if (i.path !== `${u}tiles/${e}/${n}/${r}.pbf` || f.has(i.path)) throw Error("Unexpected/duplicate catalog tile");
		f.set(i.path, i);
	}
	let m = Xe(JSON.parse(Y.decode(await s(i.metadata))), t), h = /* @__PURE__ */ new Map(), g = 0, _ = /* @__PURE__ */ new Map(), v = /* @__PURE__ */ new Set(), y = new Set(m.territories.map((e) => e.id)), b = (e) => {
		let t = new Re(new Ge(new Uint8Array(e))).layers.edges, n = [];
		for (let e = 0; e < (t?.length ?? 0); e++) {
			let r = t.feature(e).properties, i = String(r.edgeId), a = String(r.leftTerritoryId) || null, o = String(r.rightTerritoryId) || null, s = String(r.boundaryClass);
			if (!/^edge:catalog:[a-f0-9]{64}$/.test(i) || !a && !o || a && !y.has(a) || o && !y.has(o) || ![
				"country",
				"administrative",
				"coast"
			].includes(s)) throw Error("Invalid approved edge incidence");
			let c = _.get(i);
			if (c) {
				if (c.left !== a || c.right !== o || c.boundaryClass !== s) throw Error("Inconsistent approved edge incidence");
				continue;
			}
			if (_.size >= 15955) throw Error("Catalog edge cap exceeded");
			let l = Object.freeze({
				id: i,
				left: a,
				right: o,
				boundaryClass: s
			});
			_.set(i, l), n.push(l);
		}
		if (n.length) for (let e of v) e(n);
	}, x = async (e, t) => {
		t?.throwIfAborted();
		let n = f.get(e);
		if (!n) throw Error("Unregistered catalog request");
		let r = h.get(e);
		if (r) return h.delete(e), h.set(e, r), o++, r.slice(0);
		let i = await s(n, t);
		if (v.size && b(i), i.byteLength <= 8388608) {
			let t = h.get(e);
			for (t && (g -= t.byteLength, h.delete(e)), h.set(e, i), g += i.byteLength; h.size > 256 || g > 8388608;) {
				let e = h.keys().next().value;
				g -= h.get(e).byteLength, h.delete(e);
			}
		}
		return i.slice(0);
	}, S = `pax-catalog-${t.catalogVersion.replace(/^catalog-v1-/, "")}`, C = {
		type: "vector",
		tiles: [`${S}://${d}`],
		minzoom: 0,
		maxzoom: 6,
		promoteId: {
			territories: "territoryId",
			edges: "edgeId"
		},
		attribution: c.attribution
	};
	return Object.freeze({
		bootstrap: i,
		metadata: m,
		source: C,
		protocol: S,
		loadTile: x,
		observeEdges: (e) => {
			v.add(e), e([..._.values()]);
			for (let e of h.values()) b(e);
			return () => {
				v.delete(e);
			};
		},
		counters: () => ({
			verifiedRequests: a,
			cacheHits: o,
			cachedTiles: h.size,
			cachedBytes: g
		})
	});
}
async function $e(e, t = fetch, n) {
	let r = await t("/api/world/catalog", {
		signal: n,
		cache: "no-store"
	});
	if (!r.ok) throw Error("Catalog server readiness failed");
	return Qe(await r.json(), e, t, n);
}
var et = /* @__PURE__ */ new WeakMap();
function tt(e, t) {
	let n = et.get(e);
	n || (n = /* @__PURE__ */ new Map(), et.set(e, n));
	let r = n.get(t.protocol);
	if (r) {
		if (r.manifestHash !== t.bootstrap.manifest.sha256 || r.tileIndexHash !== t.bootstrap.tileIndex.sha256) throw Error("Catalog protocol identity conflict");
		r.users++, r.deliveries.set(t, (r.deliveries.get(t) ?? 0) + 1);
	} else e.addProtocol(t.protocol, async (e, n) => {
		let i = `${t.protocol}://`;
		if (!e.url.startsWith(i)) throw Error("Unexpected catalog protocol request");
		return { data: (await Promise.all([...r.deliveries.keys()].map((t) => t.loadTile(e.url.slice(i.length), n.signal))))[0] };
	}), r = {
		users: 1,
		manifestHash: t.bootstrap.manifest.sha256,
		tileIndexHash: t.bootstrap.tileIndex.sha256,
		deliveries: /* @__PURE__ */ new Map([[t, 1]])
	}, n.set(t.protocol, r);
	let i = !1;
	return () => {
		if (i) return;
		i = !0;
		let a = r.deliveries.get(t);
		a === 1 ? r.deliveries.delete(t) : r.deliveries.set(t, a - 1), --r.users === 0 && (e.removeProtocol(t.protocol), n.delete(t.protocol));
	};
}
//#endregion
//#region src/lib/world/country-map-color.ts
function nt(e) {
	P(e);
	let t = [
		1,
		3,
		5
	].map((t) => {
		let n = parseInt(e.slice(t, t + 2), 16) / 255;
		return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
	});
	return t[0] * .2126 + t[1] * .7152 + t[2] * .0722;
}
function X(e, t) {
	let n = nt(e), r = nt(t);
	return (Math.max(n, r) + .05) / (Math.min(n, r) + .05);
}
function rt(e) {
	let t = "#172E35", n = "#FFFFFF", r = X(e, t) >= 4.5 ? t : "#000000", i = X(e, r) >= X(e, n) ? r : n;
	return Object.freeze({
		mapColor: P(e),
		outlineColor: i,
		selectionColor: i,
		labelColor: i,
		labelHaloColor: i === n ? t : n
	});
}
//#endregion
//#region src/lib/projection/catalog-color-projection.ts
function it(e, t) {
	if (j(e.catalogRef, t.catalogRef), !F(t, R(e.metadata))) return null;
	let n = e.world;
	if (n.countryOrder.length !== t.countryOrder.length || n.territoryOrder.length !== t.territoryOrder.length) return null;
	let i = [];
	for (let e = 0; e < t.countryOrder.length; e++) {
		let a = t.countryOrder[e];
		if (n.countryOrder[e] !== a) return null;
		let o = n.countriesById[a], s = t.countriesById[a], { mapColor: c, ...l } = o, { mapColor: u, ...d } = s;
		if (o !== s && r(l) !== r(d)) return null;
		c !== u && i.push(a);
	}
	if (n.territoriesById !== t.territoriesById) for (let e = 0; e < t.territoryOrder.length; e++) {
		let r = t.territoryOrder[e];
		if (n.territoryOrder[e] !== r) return null;
		let i = n.territoriesById[r], a = t.territoriesById[r];
		if (i.ownerCountryId !== a.ownerCountryId || i.controllerCountryId !== a.controllerCountryId || i.sourceCountryId !== a.sourceCountryId) return null;
	}
	let a = /* @__PURE__ */ new Set();
	for (let t of i) {
		for (let n of e.ownedByCountry[t] ?? []) a.add(n);
		for (let n of e.controlledByCountry[t] ?? []) a.add(n);
	}
	let o = { ...e.featuresById }, s = [];
	for (let e of [...a].sort()) {
		let n = t.territoriesById[e], r = n.controllerCountryId ?? n.ownerCountryId, i = r ? t.countriesById[r].mapColor : "#D6D3C7";
		o[e].mapColor !== i && (o[e] = {
			...o[e],
			mapColor: i
		}, s.push(e));
	}
	return Object.freeze({
		projection: Object.freeze({
			...e,
			world: t,
			appliedRevision: t.revision,
			featuresById: o,
			search: Object.freeze({
				...e.search,
				revision: t.revision
			}),
			panel: Object.freeze({
				...e.panel,
				revision: t.revision,
				appliedRevision: t.revision
			})
		}),
		changedFeatureIds: Object.freeze(s),
		changedCountryIds: Object.freeze(i)
	});
}
function at(e) {
	return rt(e);
}
//#endregion
//#region src/lib/map/catalog-map-consumer.ts
var Z = {
	fill: "catalog-territory-fill",
	edges: "catalog-territory-edges",
	occupation: "catalog-territory-occupation",
	front: "catalog-occupation-front",
	hover: "catalog-territory-hover",
	selected: "catalog-territory-selected",
	labels: "catalog-country-labels",
	capitals: "catalog-capitals"
}, Q = "catalog-country-labels", $ = "catalog-capitals";
function ot(e) {
	let { map: t, delivery: n } = e, r = e.world, i = z(e.world, n.metadata), a = null, o = null, s = !1, c = 0;
	for (let e of [
		I,
		Q,
		$
	]) if (t.getSource(e)) throw Error("Catalog consumer source already exists");
	for (let e of Object.values(Z)) if (t.getLayer(e)) throw Error("Catalog consumer layer already exists");
	let l = (e) => ({
		labels: {
			type: "FeatureCollection",
			features: [...e.labels.pointFallbacksByLabelId.values()].map((e) => {
				let t = { ...e.properties };
				return delete t.projectionRevision, {
					...e,
					properties: t
				};
			})
		},
		capitals: {
			type: "FeatureCollection",
			features: e.capitals.features
		}
	}), u = l(i);
	t.addSource(I, n.source), t.addSource(Q, {
		type: "geojson",
		data: u.labels
	}), t.addSource($, {
		type: "geojson",
		data: u.capitals
	});
	let d = Z;
	t.addLayer({
		id: d.fill,
		type: "fill",
		source: I,
		"source-layer": "territories",
		paint: {
			"fill-color": [
				"coalesce",
				["feature-state", "mapColor"],
				"#D6D3C7"
			],
			"fill-outline-color": [
				"coalesce",
				["feature-state", "outlineColor"],
				"#53615F"
			]
		}
	}), t.addLayer({
		id: d.edges,
		type: "line",
		source: I,
		"source-layer": "edges",
		paint: {
			"line-color": "#53615F",
			"line-width": [
				"case",
				[
					"==",
					["get", "boundaryClass"],
					"administrative"
				],
				.3,
				.8
			]
		}
	}), t.addLayer({
		id: d.occupation,
		type: "fill",
		source: I,
		"source-layer": "territories",
		paint: {
			"fill-color": "#40285E",
			"fill-opacity": [
				"case",
				[
					"boolean",
					["feature-state", "occupied"],
					!1
				],
				.18,
				0
			]
		}
	}), t.addLayer({
		id: d.front,
		type: "line",
		source: I,
		"source-layer": "edges",
		paint: {
			"line-color": "#D9A43C",
			"line-width": 2,
			"line-dasharray": [3, 2],
			"line-opacity": [
				"case",
				[
					"boolean",
					["feature-state", "front"],
					!1
				],
				1,
				0
			]
		}
	});
	for (let [e, n] of [[d.hover, "hover"], [d.selected, "selected"]]) t.addLayer({
		id: e,
		type: "fill",
		source: I,
		"source-layer": "territories",
		paint: {
			"fill-color": [
				"coalesce",
				["feature-state", "selectionColor"],
				"#FFFFFF"
			],
			"fill-opacity": [
				"case",
				[
					"boolean",
					["feature-state", n],
					!1
				],
				.18,
				0
			]
		}
	});
	t.addLayer({
		id: d.labels,
		type: "symbol",
		source: Q,
		layout: {
			"text-field": ["get", "text"],
			"text-font": ["Open Sans Regular"],
			"text-size": 12
		},
		paint: {
			"text-color": [
				"coalesce",
				["feature-state", "labelColor"],
				"#FFFFFF"
			],
			"text-halo-color": [
				"coalesce",
				["feature-state", "labelHaloColor"],
				"#53615F"
			],
			"text-halo-width": 1.5
		}
	}), t.addLayer({
		id: d.capitals,
		type: "circle",
		source: $,
		paint: {
			"circle-radius": 2,
			"circle-color": "#34464D"
		}
	});
	let f = (e, n) => {
		for (let r of e) t.setFeatureState(je(i.featuresById[r].ref), n);
	}, p = (e) => {
		let { ref: t, ...n } = i.featuresById[e];
		return {
			...n,
			...at(n.mapColor),
			hover: i.featuresById[e].countryId === o && o !== null,
			selected: i.featuresById[e].countryId === a && a !== null
		};
	};
	for (let e of i.world.territoryOrder) f([e], p(e));
	let m = (e) => {
		for (let n of e) {
			let e = i.world.countriesById[n];
			e && t.setFeatureState({
				source: Q,
				id: `catalog-label:${n}`
			}, at(e.mapColor));
		}
	};
	m(i.world.countryOrder);
	let h = /* @__PURE__ */ new Map(), g = /* @__PURE__ */ new Map(), _ = /* @__PURE__ */ new Map(), v = 0, y = 0, b = (e) => {
		for (let n of e) {
			let e = g.get(n), r = e.left ? i.featuresById[e.left] : null, a = e.right ? i.featuresById[e.right] : null, o = !!(r && a && (r.occupied || a.occupied) && (r.controllerCountryId ?? r.ownerCountryId) !== (a.controllerCountryId ?? a.ownerCountryId));
			_.get(n) !== o && (_.set(n, o), t.setFeatureState({
				source: I,
				sourceLayer: "edges",
				id: n
			}, { front: o }), v++);
		}
	}, x = n.observeEdges((e) => {
		for (let t of e) {
			g.set(t.id, t);
			for (let e of [t.left, t.right]) if (e) {
				let n = h.get(e) ?? /* @__PURE__ */ new Set();
				n.add(t.id), h.set(e, n);
			}
		}
		b(e.map((e) => e.id));
	}), S = (e, t) => {
		if (s) throw Error("Catalog consumer is disposed");
		if (t !== null && !i.world.countriesById[t]) throw Error("Country is not active");
		let n = e === "hover" ? o : a;
		n !== t && (n && f(i.presentedByCountry[n] ?? [], { [e]: !1 }), t && f(i.presentedByCountry[t] ?? [], { [e]: !0 }), e === "hover" ? o = t : a = t);
	}, C = (t) => {
		let n = t.features?.map((e) => B(i, e)).find(Boolean);
		S("selected", n?.countryId ?? null), e.onSelect?.(n?.countryId ?? null), e.onTerritorySelect?.(n?.territoryId ?? null);
	}, w = (t) => {
		let n = t.features?.map((e) => B(i, e)).find(Boolean);
		S("hover", n?.countryId ?? null), e.onHover?.(n?.countryId ?? null);
	}, T = () => {
		S("hover", null), e.onHover?.(null);
	};
	return t.on("click", d.fill, C), t.on("mousemove", d.fill, w), t.on("mouseleave", d.fill, T), Object.freeze({
		getUpdateStats: () => ({
			fullProjectionBuilds: 1,
			colorProjectionUpdates: c,
			...i.projectionStats,
			territoryUpdates: y,
			edgeUpdates: v,
			indexedEdges: g.size
		}),
		getProjection: () => i,
		getCountryPanel: (e) => Ae(i, e),
		selectCountry: (e) => S("selected", e),
		hoverCountry: (e) => S("hover", e),
		updateWorld: (n) => {
			if (s) throw Error("Catalog consumer is disposed");
			if (n === r || n === i.world) return;
			if (n.revision <= i.appliedRevision) throw Error("Stale catalog projection revision");
			let u = it(i, n);
			if (u) {
				i = u.projection, r = n, c++;
				for (let e of u.changedFeatureIds) f([e], p(e));
				y += u.changedFeatureIds.length, m(u.changedCountryIds);
				return;
			}
			let d = i, g = ke(d, n), _ = g.projection;
			i = _, r = n, a && !_.world.countriesById[a] && (a = null, e.onSelect?.(null)), o && !_.world.countriesById[o] && (o = null, e.onHover?.(null));
			for (let e of g.changedFeatureIds) f([e], p(e));
			y += g.changedFeatureIds.length, b(new Set(g.changedFeatureIds.flatMap((e) => [...h.get(e) ?? []])));
			let v = l(d), x = l(_);
			for (let [e, n, r] of [[
				Q,
				v.labels,
				x.labels
			], [
				$,
				v.capitals,
				x.capitals
			]]) {
				let { diff: i, changedIds: a } = Ne(n, r, e);
				if (!a.length) continue;
				let o = t.getSource(e);
				if (!o || typeof o.updateData != "function") throw Error("Catalog incremental presentation source is missing");
				o.updateData(i);
			}
			m(_.world.countryOrder.filter((e) => d.world.countriesById[e]?.mapColor !== _.world.countriesById[e].mapColor));
		},
		dispose: () => {
			if (!s) {
				x(), t.off("click", d.fill, C), t.off("mousemove", d.fill, w), t.off("mouseleave", d.fill, T);
				for (let e of Object.values(d).reverse()) t.getLayer(e) && t.removeLayer(e);
				for (let e of [
					$,
					Q,
					I
				]) t.getSource(e) && t.removeSource(e);
				s = !0;
			}
		}
	});
}
async function st(e) {
	let t = await $e(e.world.catalogRef, e.fetcher, e.signal);
	e.signal?.throwIfAborted();
	let n = tt(e.protocolApi, t);
	try {
		let r = ot({
			...e,
			delivery: t
		}), i = !1;
		return Object.freeze({
			...r,
			dispose: () => {
				i ||= (r.dispose(), n(), !0);
			}
		});
	} catch (e) {
		throw n(), e;
	}
}
//#endregion
export { Z as CATALOG_MAP_LAYER_IDS, ot as createCatalogMapConsumer, st as mountCatalogMapConsumer };
