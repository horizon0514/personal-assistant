# @pa/cap-filesystem

FileSystem Capability —— 文件/文档读写、提取(支撑域)

已实现:`list_dir`/`read_file`/`find_files`/`grep_files`(只读)+ `write_file`/`delete`/`move_file`(可逆变更)+ `plan_file_changes`(批量 move/delete,diff 预览 + 整批审批 + 回滚)。职责与模型见 [`research/domain-model.md`](../../research/domain-model.md)。
