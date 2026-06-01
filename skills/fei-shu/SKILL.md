---
name: fei-shu
description: 飞书(Lark)操作——发消息、搜消息/群、查日程、搜同事等,底层调本机 lark-cli。
safeShell:
  - 'lark-cli auth status'
  - 'lark-cli --help'
  - 'lark-cli * --help'
  - 'lark-cli * +*search*'
  - 'lark-cli * +*list*'
  - 'lark-cli * +get*'
  - 'lark-cli * +agenda'
  - 'lark-cli * +freebusy'
  - 'lark-cli api GET *'
---
# 飞书 Skill

通过本机已安装的 `lark-cli` 操作飞书。所有动作都用 **exec_shell** 跑 `lark-cli ...` 命令完成。

## 开工前:确认已登录
先跑 `lark-cli auth status` 看是否已登录。未登录时**不要**自己尝试登录(需要设备码交互),而是用 `ask_user` 提示用户运行 `lark-cli auth login` 后再继续。

## 常用操作

发送消息(机器人身份):
```
lark-cli im +messages-send --data '{"receive_id":"<chat_id 或 user open_id>","msg_type":"text","content":"{\"text\":\"要发的内容\"}"}'
```
- 不知道 chat_id 时,先用 `lark-cli im +chat-search --query "群名"` 查;
- 发给个人时 receive_id 用对方 open_id,可经 `lark-cli contact +search-user --query "姓名"` 查。

搜消息 / 列消息:
```
lark-cli im +messages-search --query "关键词"
lark-cli im +chat-messages-list --params '{"chat_id":"<chat_id>"}'
```

查日程(今天/近期):
```
lark-cli calendar +agenda
```

搜同事:
```
lark-cli contact +search-user --query "姓名或邮箱"
```

通用 API(没有现成子命令时):
```
lark-cli api GET /open-apis/...  --params '{...}'
lark-cli api POST /open-apis/... --data '{...}'
```

## 规矩
- **发消息、改群、删除等会改外部状态的操作执行前,先用一句话向用户确认要发的对象和内容**(exec_shell 也会就该命令弹审批,但你仍要让用户看清)。
- 查询类(status / search / agenda / list)只读,放心跑。
- 命令失败先读 stderr:多半是未登录、scope 不足或 id 不对——按错误信息修正参数或提示用户授权,别瞎试。
- `lark-cli --help`、`lark-cli <command> --help` 可现查子命令与参数。
