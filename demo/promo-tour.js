// 产品宣传视频自动导览（仅当 URL 含 ?tour=1 时激活，正常使用不受影响）。
// 以真实用户操作的方式自动演示四步流程：打开项目 → 构建目录树 → 关联低层需求 → 生成导出。
(function () {
  if (!/[?&]tour=1/.test(location.search)) return;

  // 演示录制期间屏蔽弹窗，避免打断录制
  window.alert = (msg) => console.log("[demo:alert]", msg);
  window.confirm = () => true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function overlay(text, sub, keep) {
    const el = document.createElement("div");
    el.className = "promo-overlay";
    el.innerHTML =
      '<div class="promo-overlay-title">' + text + "</div>" +
      (sub ? '<div class="promo-overlay-sub">' + sub + "</div>" : "");
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    return {
      async hide() {
        if (keep) return;
        el.classList.remove("show");
        await sleep(500);
        el.remove();
      },
    };
  }

  function flash(el) {
    if (!el) return;
    el.classList.add("promo-flash");
    setTimeout(() => el.classList.remove("promo-flash"), 900);
  }

  async function typeChapter(title) {
    document.querySelector("#doc-add-btn").click();
    await sleep(260);
    const input = document.querySelector("#doc-edit-input");
    if (!input) return;
    input.focus();
    for (const ch of title) {
      input.value += ch;
      await sleep(55);
    }
    await sleep(220);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(260);
  }

  async function run() {
    // 启动延迟可通过 ?delay=毫秒 配置（供录制流程先于导览启动）
    const startDelay = Number(new URLSearchParams(location.search).get("delay")) || 1800;
    await sleep(startDelay);

    // 片头
    const head = overlay("CodeDocBench", "C 代码解析 · 文档目录树 · 低层需求关联 · 一键导出");
    await sleep(2600);
    await head.hide();

    // ── 步骤 1：打开项目 ──
    flash(document.querySelector(".open-hint"));
    document.querySelector(".open-hint").click();
    await sleep(900);
    flash(document.getElementById("project-bar"));
    await sleep(700);

    // 浏览一个文件的解析详情
    const fileNames = [...document.querySelectorAll("#tree-container .node-row.file .name")];
    const target = fileNames.find((n) => n.textContent.includes("Demo_PWR_Init.c")) || fileNames[0];
    if (target) {
      flash(target);
      target.click();
      await sleep(300);
      const detail = document.querySelector("#detail-panel");
      if (detail) detail.scrollTop = 260;
      await sleep(2200);
    }

    // ── 步骤 2：构建文档目录树 ──
    document.querySelector('.step-item[data-step="2"]').click();
    await sleep(900);

    await typeChapter("系统概要设计");
    await typeChapter("接口模块"); // 选中态 → 子章节
    document.getElementById("doc-tree-container").click(); // 取消选中
    await sleep(200);
    await typeChapter("数据记录模块");
    await sleep(600);

    // 选中「接口模块」→ 筛选 .c → 勾选根目录 → 挂载
    const sub = [...document.querySelectorAll("#doc-tree-container .node-row.doc .name")].find(
      (n) => n.textContent === "接口模块"
    );
    if (sub) {
      flash(sub);
      sub.click();
      await sleep(400);
    }
    const chip = [...document.querySelectorAll(".filter-chip")].find((c) =>
      c.textContent.trim().startsWith(".c")
    );
    if (chip) {
      flash(chip);
      chip.click();
      await sleep(500);
    }
    const dirCb = document.querySelector("#doc-project-tree .node-row.dir input[type=checkbox]");
    if (dirCb) {
      flash(dirCb);
      dirCb.click();
      await sleep(500);
    }
    const mountBtn = document.getElementById("doc-mount-btn");
    flash(mountBtn);
    mountBtn.click();
    await sleep(1500);
    document.getElementById("doc-collapse-btn").click(); // 折叠全部,先看整体结构
    await sleep(900);
    document.getElementById("doc-expand-btn").click(); // 再展开
    await sleep(1600);

    // ── 步骤 3：关联低层需求 ──
    document.querySelector('.step-item[data-step="3"]').click();
    await sleep(800);
    document.getElementById("rel-pick-btn").click();
    await sleep(700);
    const setSel = (id, val) => {
      const s = document.getElementById(id);
      if (s) {
        s.value = val;
        s.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
    setSel("rel-col-chapter", "Section");
    setSel("rel-col-id", "Requirement ID");
    setSel("rel-col-content", "Title / Requirement Text");
    setSel("rel-col-object", "Type");
    await sleep(2200);

    // ── 步骤 4：生成文档 ──
    document.querySelector('.step-item[data-step="4"]').click();
    await sleep(1200);
    const preview = document.getElementById("gen-preview");
    if (preview) preview.scrollTop = 300;
    await sleep(1800);
    const runBtn = document.getElementById("gen-run-btn");
    flash(runBtn);
    runBtn.click();
    await sleep(1500);

    // 片尾
    const tail = overlay("CodeDocBench", "从代码到文档，一键生成 · 立即体验");
    await sleep(3200);
    await tail.hide();
  }

  if (document.readyState === "complete") run();
  else window.addEventListener("load", run);
})();
