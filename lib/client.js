// 幂等护栏（同时兼顾 HMR）：
//
// 1) 同一个 bundle 若被两条 Loader 行挂载（插件自带的 bundle patch 已经插了一行，
//    用户又在 profile 的 cordis.patch.yml 里手写了一条），浏览器会把这个脚本执行两次。
//    DSH 的 client-modules 在 queue 模式下 load 不查重，重复项会在 create() 回放时
//    撞上 register() 的查重而抛
//      client-modules: duplicate factory registration for "dsh-3d-whale-pet"
//    并且是**整个模块系统构造失败**（所有客户端半边都死）。所以 queue 模式的第二遍
//    直接跳过。
// 2) 但热更新（HMR）换 rev 时会先 invalidate（删掉 id 的 factory/loadCache）再重放本脚本，
//    那时必须允许再注册一次，否则会报
//      could not load "dsh-3d-whale-pet": ... loaded without registering
//    因此只在「已经 live 运行」时放行重放，并用 try/catch 只吞掉重复注册这一种错。
if (window.__3dWhalePetClientRegistered__ && window.__ModuleLoader__.mode !== "live") {
	// queue 模式的第二遍执行：工厂已入队，再注册一次会炸掉整个模块系统，跳过
} else {
	window.__3dWhalePetClientRegistered__ = true;
	try {
		window.__ModuleLoader__.load({
	// 注册 id 必须等于本包的 package.json name：DSH 的 client-modules 用
	// 「最近的 package manifest 名」作为浏览器模块 id，并在此 id 上等这条
	// bundle 注册；对不上会报 "loaded without registering ..." 而整条客户端半边失效。
	id: "dsh-3d-whale-pet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const slots = require("@deepseek-ai/dsh-client-ui-slots");
		// 面板要挂在 body 上：侧边栏带 transform 时，fixed 会相对它定位而跑偏。
		// react-dom 拿不到就退回普通渲染，不冒「整个客户端半边挂掉」的风险。
		let createPortal = null;
		try { createPortal = require("react-dom").createPortal || null; } catch { createPortal = null; }

		// 命名空间与插槽 id 都用 dsh-3d-whale-pet 前缀：DSH 的 sidebar.footer.action 是
		// 列表插槽，只有「用别人已占用的 id」才会替换；用独有 id 一律新增。
		// 这样虎鲸桌宠可以和别的宠物插件共存，不会互相顶掉。
		const NS = "dsh-3d-whale-pet";
		const RPC = "/dsh-3d-whale-pet/rpc";
		const SLOT_ID = "dsh-3d-whale-pet";

		/** 调 Host 半边。 */
		async function callHost(method, args) {
			const res = await fetch(RPC, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ method, args }),
			});
			if (!res.ok) throw new Error(`whale-pet rpc HTTP ${res.status}`);
			return res.json();
		}

		/** 侧边栏底部按钮：打开/关闭桌宠面板。 */
		function WhalePetButton(props) {
			const [open, setOpen] = React.useState(false);
			const [status, setStatus] = React.useState({ running: false });
			const [balance, setBalance] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);

			// 打开时轮询状态。
			React.useEffect(() => {
				if (!open) return;
				let alive = true;
				const tick = async () => {
					try {
						const s = await callHost("status");
						if (alive) { setStatus(s); setError(s.error ?? null); }
					} catch (e) {
						if (alive) setError(String(e.message || e));
					}
				};
				tick();
				const id = setInterval(tick, 3000);
				return () => { alive = false; clearInterval(id); };
			}, [open]);

			const toggle = async () => {
				setBusy(true); setError(null);
				try {
					const r = await callHost(status.running ? "stop" : "start");
					if (r && r.ok === false) setError(r.error);
					const s = await callHost("status");
					setStatus(s);
				} catch (e) {
					setError(String(e.message || e));
				} finally { setBusy(false); }
			};

			// 依赖缺失时的一键安装（主要是 electron，约 180MB）。
			// pnpm 10+ 默认拦截依赖的 postinstall，所以只能由用户在此显式触发。
			const doInstall = async () => {
				setBusy(true); setError("正在安装依赖（约 180MB，请耐心等待）…");
				try {
					const r = await callHost("install");
					if (r && r.ok === false) setError(r.error);
					else setError(null);
					setStatus(await callHost("status"));
				} catch (e) {
					setError(String(e.message || e));
				} finally { setBusy(false); }
			};

			// 改安装位置：把运行时（electron 那 180MB）挪到别的盘
			const applyLoc = async () => {
				setBusy(true); setError(null);
				try {
					const r = await callHost("setRuntimeDir", { dir: locValue });
					if (r && r.ok === false) setError(r.error);
					else {
						setLocOpen(false);
						const st = await callHost("status");
						setStatus(st);
						setLocNote(`✓ 已改到 ${st.runtimeDir || "(默认)"}`);
					}
				} catch (e) {
					setError(String(e.message || e));
				} finally { setBusy(false); }
			};

			const checkBalance = async () => {
				setBusy(true); setError(null);
				try {
					const b = await callHost("balance");
					setBalance(b);
					if (b && b.ok === false) setError(b.error);
				} catch (e) { setError(String(e.message || e)); }
				finally { setBusy(false); }
			};

			const label = "🐋 3D小虎鲸";

			// 按钮和图层面板分开：点开之后按钮仍留在侧边栏（再点一下收起），
			// 面板贴着按钮右侧弹出，而不是飘到屏幕右下角。
			const btnRef = React.useRef(null);
			const [anchor, setAnchor] = React.useState(null);
			const [locOpen, setLocOpen] = React.useState(false);   // 是否在改安装位置
			const [locValue, setLocValue] = React.useState("");
			const [locNote, setLocNote] = React.useState("");   // 改完给一句确认

			React.useLayoutEffect(() => {
				if (!open) return;
				const measure = () => {
					const el = btnRef.current;
					if (!el) return;
					const r = el.getBoundingClientRect();
					setAnchor({
						left: Math.round(r.right) + 10,
						bottom: Math.max(12, Math.round(window.innerHeight - r.bottom)),
					});
				};
				measure();
				window.addEventListener("resize", measure);
				return () => window.removeEventListener("resize", measure);
			}, [open]);

			const money = balance && balance.ok
				? `${balance.currency === "USD" ? "$" : "¥"}${Number(balance.total).toFixed(2)}`
				: null;
			const low = balance && balance.ok && balance.total < 1;

			const row = (children) => React.createElement("div", {
				style: { display: "flex", alignItems: "center", gap: "8px", margin: "6px 0" },
			}, children);

			const btn = (text, onClick, danger) => React.createElement("button", {
				type: "button",
				onClick,
				disabled: busy,
				style: {
					padding: "5px 12px", borderRadius: "8px", cursor: busy ? "default" : "pointer",
					border: "1px solid var(--dsw-alias-border-l2, #444)",
					background: danger ? "var(--dsw-alias-bg-danger, #5a1f1f)" : "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))",
					color: "var(--dsw-alias-label-primary, inherit)",
					font: "inherit", fontSize: "13px", opacity: busy ? 0.6 : 1,
				},
			}, text);

			// 侧边栏里的那个按钮：一直在，点一下开/关面板
			const trigger = React.createElement("button", {
				ref: btnRef,
				type: "button",
				onClick: () => setOpen((v) => !v),
				title: label,
				style: {
					display: "flex", alignItems: "center", gap: "8px",
					width: "100%", padding: "8px 10px", margin: "2px 0",
					background: open ? "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.10))" : "transparent",
					border: "none", borderRadius: "12px",
					color: "var(--dsw-alias-label-primary, inherit)",
					font: "inherit", fontSize: "14px", cursor: "pointer", textAlign: "left",
				},
			}, label);

			if (!open || !anchor) return trigger;

			const panel = React.createElement("div", {
				style: {
					position: "fixed", left: `${anchor.left}px`, bottom: `${anchor.bottom}px`, zIndex: 9999,
					width: "260px", padding: "14px 16px", borderRadius: "16px",
					background: "var(--dsw-alias-bg-layer-2, #1e1e24)",
					boxShadow: "var(--dsw-elevation-prominent, 0 8px 32px rgba(0,0,0,.45))",
					color: "var(--dsw-alias-label-primary, #eee)",
					font: "inherit", fontSize: "14px",
				},
			},
				row([
					React.createElement("strong", { key: "t", style: { flex: 1 } }, label),
					btn("✕", () => setOpen(false)),
				]),
				row([
					React.createElement("span", { key: "s", style: { flex: 1 } },
						status.installing ? "⏳ 安装依赖中…"
							: status.running ? "🟢 运行中"
							: status.ready ? "⚪ 未启动"
							: "🔧 依赖未装"),
					btn(status.running ? "关闭" : "启动", toggle),
				]),
				// 安装位置：平时只显示一行小字；想改的时候才展开输入框。
				// 桌宠运行中不让改（文件被占用），所以那时连「更改」都不显示。
				React.createElement("div", {
					style: { fontSize: "11px", opacity: 0.6, marginTop: "2px", wordBreak: "break-all" },
				}, [
					React.createElement("span", { key: "p" }, `安装位置：${status.runtimeDir || "(默认)"}`),
					(!locOpen && !status.running) ? React.createElement("button", {
						key: "chg", type: "button",
						onClick: () => { setLocOpen(true); setLocValue(status.runtimeDir || ""); setLocNote(""); },
						style: {
							marginLeft: "6px", padding: "0 4px", border: "none", background: "none",
							color: "var(--dsw-alias-label-brand, #6b8afd)", font: "inherit", fontSize: "11px", cursor: "pointer",
						},
					}, "更改") : null,
				]),
				locOpen ? React.createElement("div", { style: { display: "flex", gap: "6px", margin: "6px 0" } }, [
					React.createElement("input", {
						key: "loc",
						value: locValue,
						placeholder: "例如 D:\\\\whale-pet-runtime（留空=恢复默认）",
						onChange: (e) => setLocValue(e.target.value),
						style: {
							flex: 1, minWidth: 0, padding: "4px 8px", borderRadius: "8px",
							border: "1px solid var(--dsw-alias-border-l2, #444)",
							background: "transparent", color: "inherit", font: "inherit", fontSize: "12px",
						},
					}),
					btn(busy ? "搬移中…" : "保存", applyLoc),
					btn("取消", () => setLocOpen(false)),
				]) : null,
				locNote ? React.createElement("div", {
					style: { fontSize: "11px", color: "#3fb27f", marginTop: "2px", wordBreak: "break-all" },
				}, locNote) : null,
				// 依赖缺失时给一个明确的一键安装入口，否则用户只会看到「启动失败」
				!status.ready ? row([
					React.createElement("span", { key: "d", style: { flex: 1, fontSize: "12px", opacity: 0.75 } },
						"首次使用需装 electron"),
					btn(status.installing ? "安装中…" : "安装依赖", doInstall),
				]) : null,
				// DSH 桌面版端口每次启动都变，这里把当前地址直接显示出来：
				// 连不上时用户不用自己去查端口，也方便手动启动桌宠时设置 WHALE_PET_URL。
				status.dshUrl ? React.createElement("div", {
					style: { fontSize: "11px", opacity: 0.6, marginTop: "2px", wordBreak: "break-all" },
				}, `DSH: ${status.dshUrl}`) : null,
				row([
					React.createElement("span", { key: "b", style: { flex: 1 } },
						money ? `${low ? "⚡ " : "💰 "}余额 ${money}` : "💰 未查询"),
					btn("查余额", checkBalance),
				]),
				low ? React.createElement("div", {
					style: { color: "#f0a020", fontSize: "12px", marginTop: "4px" },
				}, "⚡ 余额偏低，记得充值") : null,
				error ? React.createElement("div", {
					style: { color: "#ff6b6b", fontSize: "12px", marginTop: "6px", wordBreak: "break-all" },
				}, error) : null,
			);

			return React.createElement(React.Fragment, null,
				trigger,
				createPortal ? createPortal(panel, document.body) : panel,
			);
		}

		/** 注册到侧边栏底部的动作区。 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				// 独有 id：列表插槽会把它新增在已有序项旁边，而不是替换别人。
				// 其他宠物插件只要用它们自己的 id，就能与本插件共存。
				id: SLOT_ID,
				order: 100,
				label: () => "🐋 3D小虎鲸",
			}, WhalePetButton));
		}

		const inject = ["slots"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
		});
	} catch (err) {
		// live 模式下重复挂载时 register 会抛这一种错：吞掉它，别连带整页的其它插件。
		// 其它错误（语法/依赖缺失等）必须继续抛，否则样式问题和加载失败都会被掩盖。
		if (!/duplicate factory registration/u.test(String(err && err.message))) throw err;
	}
}