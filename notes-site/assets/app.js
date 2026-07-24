(() => {
  const root = document.body.dataset.siteRoot || "./";
  const storageKey = "code-reading-theme";
  const themeButton = document.querySelector("[data-theme-toggle]");

  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    if (themeButton) {
      themeButton.setAttribute(
        "aria-label",
        theme === "dark" ? "切换到浅色主题" : "切换到深色主题",
      );
    }
  };

  const savedTheme = localStorage.getItem(storageKey);
  const preferredTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
  applyTheme(savedTheme || preferredTheme);
  themeButton?.addEventListener("click", () => {
    const next =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(storageKey, next);
    applyTheme(next);
  });

  const sidebar = document.querySelector("[data-sidebar]");
  const backdrop = document.querySelector("[data-sidebar-backdrop]");
  const closeSidebar = () => {
    sidebar?.classList.remove("is-open");
    backdrop?.classList.remove("is-visible");
  };
  document.querySelector("[data-mobile-menu]")?.addEventListener("click", () => {
    sidebar?.classList.toggle("is-open");
    backdrop?.classList.toggle("is-visible");
  });
  backdrop?.addEventListener("click", closeSidebar);
  sidebar?.querySelectorAll("a").forEach((link) =>
    link.addEventListener("click", closeSidebar),
  );

  const dialog = document.querySelector("[data-search-dialog]");
  const searchInput = document.querySelector("[data-search-input]");
  const resultsElement = document.querySelector("[data-search-results]");
  const searchData = window.__NOTES_SEARCH__ || [];

  const escapeHtml = (value = "") =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const normalize = (value) => value.toLocaleLowerCase("zh-CN");
  const scoreEntry = (entry, query) => {
    const title = normalize(entry.title);
    const project = normalize(entry.project);
    const headings = normalize(entry.headings.map((item) => item.text).join(" "));
    const text = normalize(entry.text);
    let score = 0;
    if (title === query) score += 100;
    if (title.includes(query)) score += 40;
    if (project.includes(query)) score += 25;
    if (headings.includes(query)) score += 20;
    if (text.includes(query)) score += 5;
    return score;
  };

  const snippet = (text, query) => {
    const normalized = normalize(text);
    const index = normalized.indexOf(query);
    const start = Math.max(0, index < 0 ? 0 : index - 42);
    const value = text.slice(start, start + 132);
    return `${start > 0 ? "…" : ""}${value}${start + 132 < text.length ? "…" : ""}`;
  };

  const renderResults = (rawQuery) => {
    if (!resultsElement) return;
    const query = normalize(rawQuery.trim());
    if (!query) {
      resultsElement.innerHTML = `<p class="search-hint">输入关键词搜索全部 ${searchData.length} 篇笔记</p>`;
      return;
    }
    const matches = searchData
      .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    if (!matches.length) {
      resultsElement.innerHTML = `<div class="search-empty"><strong>没有找到“${escapeHtml(rawQuery)}”</strong><span>可以尝试项目名、类名、方法名或架构术语。</span></div>`;
      return;
    }
    resultsElement.innerHTML = matches
      .map(({ entry }) => {
        const heading = entry.headings.find((item) =>
          normalize(item.text).includes(query),
        );
        const href = `${root}${entry.url}${heading ? `#${encodeURIComponent(heading.id)}` : ""}`;
        return `<a class="search-result" href="${href}">
          <span class="search-result-project">${escapeHtml(entry.project)}</span>
          <strong>${escapeHtml(entry.title)}</strong>
          <span>${escapeHtml(snippet(entry.text, query))}</span>
        </a>`;
      })
      .join("");
  };

  const openSearch = () => {
    if (!dialog) return;
    dialog.showModal();
    requestAnimationFrame(() => searchInput?.focus());
  };
  const closeSearch = () => dialog?.close();
  document
    .querySelectorAll("[data-search-open]")
    .forEach((button) => button.addEventListener("click", openSearch));
  document
    .querySelector("[data-search-close]")
    ?.addEventListener("click", closeSearch);
  searchInput?.addEventListener("input", (event) =>
    renderResults(event.target.value),
  );
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) closeSearch();
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      dialog?.open ? closeSearch() : openSearch();
    }
  });

  const copyText = async (value) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  };

  document.querySelectorAll(".copy-code").forEach((button) => {
    button.addEventListener("click", async () => {
      const code = button.closest(".code-block")?.querySelector("code")?.textContent;
      if (!code) return;
      await copyText(code);
      button.textContent = "已复制";
      window.setTimeout(() => {
        button.textContent = "复制";
      }, 1400);
    });
  });
  document.querySelectorAll("[data-copy-text]").forEach((button) => {
    button.addEventListener("click", async () => {
      await copyText(button.dataset.copyText || "");
      const original = button.textContent;
      button.textContent = "已复制";
      window.setTimeout(() => {
        button.textContent = original;
      }, 1400);
    });
  });

  const tocLinks = [...document.querySelectorAll(".toc-link")];
  const headingById = new Map(
    tocLinks
      .map((link) => {
        const id = decodeURIComponent(link.hash.slice(1));
        return [id, document.getElementById(id)];
      })
      .filter(([, heading]) => heading),
  );
  if (headingById.size) {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (!visible.length) return;
        const activeId = visible[0].target.id;
        tocLinks.forEach((link) =>
          link.classList.toggle(
            "is-active",
            decodeURIComponent(link.hash.slice(1)) === activeId,
          ),
        );
      },
      { rootMargin: "-15% 0px -72% 0px" },
    );
    headingById.forEach((heading) => observer.observe(heading));
  }

  const sourceHash = window.location.hash.match(/^#L(\d+)$/);
  if (sourceHash) {
    document.getElementById(`L${sourceHash[1]}`)?.classList.add("is-targeted");
  }
})();
