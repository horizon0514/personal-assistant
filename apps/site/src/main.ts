import "./style.css";

/**
 * 下载区:按访客系统填充主按钮,并从 GitHub 最新 Release 解析安装包直链。
 * 取不到(如 release 还是草稿)时,优雅回退到 Releases 页面。
 */
const REPO = "horizon0514/personal-assistant";
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

type OS = "mac" | "win" | "other";

function detectOS(): OS {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "win";
  return "other";
}

interface Asset {
  name: string;
  browser_download_url: string;
}
interface Release {
  tag_name: string;
  assets: Asset[];
}

function pick(assets: Asset[], test: (n: string) => boolean): string | undefined {
  return assets.find((a) => test(a.name.toLowerCase()))?.browser_download_url;
}

async function hydrate(): Promise<void> {
  const os = detectOS();
  const primary = document.getElementById("primary-dl") as HTMLAnchorElement | null;
  const primaryLabel = document.getElementById("primary-dl-label");
  const alt = document.getElementById("alt-dl");
  const versionEl = document.getElementById("dl-version");

  // 主按钮文案先按系统给出(链接默认指向 Releases 页,拿到直链后再覆盖)。
  if (primaryLabel) {
    primaryLabel.textContent =
      os === "mac" ? "下载 for macOS" : os === "win" ? "下载 for Windows" : "下载 Akari";
  }

  let release: Release | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" }
    });
    if (res.ok) release = (await res.json()) as Release;
  } catch {
    /* 网络/接口异常:保持回退到 Releases 页 */
  }

  if (!release) {
    if (versionEl) versionEl.textContent = "前往 Releases 选择安装包";
    return;
  }

  const a = release.assets;
  const macArm = pick(a, (n) => n.endsWith(".dmg") && n.includes("arm64"));
  const macX64 = pick(a, (n) => n.endsWith(".dmg") && (n.includes("x64") || n.includes("intel")));
  const win = pick(a, (n) => n.endsWith(".exe"));

  const links: { label: string; url?: string }[] = [
    { label: "macOS · Apple 芯片", url: macArm },
    { label: "macOS · Intel", url: macX64 },
    { label: "Windows", url: win }
  ];

  // 主按钮直链
  const primaryUrl = os === "mac" ? (macArm ?? macX64) : os === "win" ? win : undefined;
  if (primary) primary.href = primaryUrl ?? RELEASES_PAGE;
  const footer = document.getElementById("footer-dl") as HTMLAnchorElement | null;
  if (footer) footer.href = primaryUrl ?? RELEASES_PAGE;

  // 其它平台链接
  if (alt) {
    alt.innerHTML = "";
    for (const { label, url } of links) {
      if (!url || url === primaryUrl) continue;
      const el = document.createElement("a");
      el.href = url;
      el.textContent = label;
      el.className = "underline-offset-4 hover:text-stone-300 hover:underline";
      alt.appendChild(el);
    }
  }

  if (versionEl) versionEl.textContent = `最新版本 ${release.tag_name}`;
}

void hydrate();
