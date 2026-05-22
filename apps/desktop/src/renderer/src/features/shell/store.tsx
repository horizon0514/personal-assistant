import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { SessionRecord, WorkspaceRecord } from "../../../../preload";
import type { ArtifactContent, BatchState } from "./types";

/**
 * 应用外壳状态。workspace/session 经 IPC 落到 infra 持久化;
 * artifact / sidebar 为纯 UI 态。
 */
interface ShellState {
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string;
  setActiveWorkspace: (id: string) => void;
  createWorkspace: (name: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  deleteWorkspace: (id: string) => void;
  canDeleteWorkspace: boolean;

  sessions: SessionRecord[]; // 当前 workspace 的会话
  activeSessionId: string;
  setActiveSession: (id: string) => void;
  newSession: () => void;
  archiveSession: (id: string) => void;
  /** 发消息前确保有会话,返回其 id */
  ensureSession: () => Promise<string>;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  sidebarWidth: number;
  setSidebarWidth: (px: number) => void;

  artifact: ArtifactContent | null;
  openArtifact: (content: ArtifactContent) => void;
  closeArtifact: () => void;
}

const ShellContext = createContext<ShellState | null>(null);

export function ShellProvider({ children }: { children: ReactNode }): JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("pa.sidebarCollapsed") === "1");
  const [sidebarWidth, setSidebarWidthRaw] = useState(() => Number(localStorage.getItem("pa.sidebarWidth")) || 248);
  const [artifact, setArtifact] = useState<ArtifactContent | null>(null);

  // 初次加载:workspace + 当前 workspace 的会话
  useEffect(() => {
    void (async () => {
      const [ws, active, ss] = await Promise.all([
        window.pa.workspace.list(),
        window.pa.workspace.active(),
        window.pa.session.list()
      ]);
      setWorkspaces(ws);
      setActiveWorkspaceId(active);
      setSessions(ss);
    })();
  }, []);

  // 会话列表变化(自动命名 / 落盘)
  useEffect(() => window.pa.session.onChanged(setSessions), []);

  // sidebar 状态持久化
  useEffect(() => {
    localStorage.setItem("pa.sidebarCollapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem("pa.sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  // 批量改动预览 → 自动弹出右侧 artifact
  useEffect(() => {
    return window.pa.batch.onRequest((req) => {
      const batch = req as unknown as BatchState;
      setArtifact({
        id: batch.actionId,
        kind: "batch",
        title: `批量改动 · ${batch.operations.length} 项`,
        batch
      });
    });
  }, []);

  // 内置浏览器调研 → 自动弹出「浏览器」artifact(面板内挂 <webview>)
  useEffect(() => {
    return window.pa.browser.onShow(() => {
      setArtifact((cur) => (cur?.kind === "browser" ? cur : { id: "browser", kind: "browser", title: "调研浏览器" }));
    });
  }, []);

  const value: ShellState = {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspace: (id) => {
      void (async () => {
        const ss = await window.pa.workspace.switch(id);
        setActiveWorkspaceId(id);
        setSessions(ss);
        setActiveSessionId("");
        setArtifact(null);
      })();
    },
    createWorkspace: (name) => {
      void (async () => {
        const rec = await window.pa.workspace.create(name);
        setWorkspaces((prev) => [...prev, rec]);
        const ss = await window.pa.workspace.switch(rec.id);
        setActiveWorkspaceId(rec.id);
        setSessions(ss);
        setActiveSessionId("");
        setArtifact(null);
      })();
    },
    renameWorkspace: (id, name) => {
      void window.pa.workspace.rename(id, name).then(setWorkspaces);
    },
    deleteWorkspace: (id) => {
      void (async () => {
        const { workspaces: list, activeWorkspaceId: nextActive } = await window.pa.workspace.delete(id);
        setWorkspaces(list);
        if (nextActive !== activeWorkspaceId) {
          const ss = await window.pa.session.list();
          setActiveWorkspaceId(nextActive);
          setSessions(ss);
          setActiveSessionId("");
          setArtifact(null);
        }
      })();
    },
    canDeleteWorkspace: workspaces.length > 1,
    sessions,
    activeSessionId,
    setActiveSession: setActiveSessionId,
    newSession: () => {
      void window.pa.session.create().then((rec) => {
        setSessions((prev) => [rec, ...prev]);
        setActiveSessionId(rec.id);
      });
    },
    archiveSession: (id) => {
      void window.pa.session.archive(id).then(() => {
        setSessions((prev) => prev.filter((s) => s.id !== id));
        setActiveSessionId((cur) => (cur === id ? "" : cur));
      });
    },
    ensureSession: async () => {
      if (activeSessionId) return activeSessionId;
      const rec = await window.pa.session.create();
      setSessions((prev) => [rec, ...prev]);
      setActiveSessionId(rec.id);
      return rec.id;
    },
    sidebarCollapsed,
    toggleSidebar: () => setSidebarCollapsed((c) => !c),
    sidebarWidth,
    setSidebarWidth: (px) => setSidebarWidthRaw(Math.max(208, Math.min(420, px))),
    artifact,
    openArtifact: setArtifact,
    closeArtifact: () => setArtifact(null)
  };

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellState {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell 必须在 ShellProvider 内使用");
  return ctx;
}
