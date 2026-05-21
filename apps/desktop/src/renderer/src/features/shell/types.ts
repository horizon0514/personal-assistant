/** 应用外壳共享类型:workspace / session / artifact */

export interface Workspace {
  id: string;
  name: string;
  /** 记忆/偏好/会话隔离的命名空间;不强绑文件目录 */
  defaultDir?: string;
}

export interface SessionMeta {
  id: string;
  workspaceId: string;
  title: string;
  /** 最近活跃时间(用于排序),ISO 字符串 */
  updatedAt: string;
}

/** 批量改动操作(与 cap-filesystem 的 FileChangeOp 渲染兼容) */
export type BatchOp = { op: "move"; from: string; to: string } | { op: "delete"; path: string };

export interface BatchState {
  actionId: string;
  operations: BatchOp[];
}

/** 右侧 artifact 面板内容:一次一个 */
export type ArtifactContent =
  | { id: string; kind: "batch"; title: string; batch: BatchState }
  | { id: string; kind: "text"; title: string; body: string };
