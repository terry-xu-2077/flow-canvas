# Flow 画布

局域网多人使用的无限画布生图服务，后端对接自建的 [flow2api](../flow2api)。

- 卡片式工作流：**生成卡片**（提示词 / 模型 / 比例 / 分辨率 / 张数）→ 结果图片出现在卡片右侧。
- **连图**：从图片右侧圆点拖线到生成卡片左侧，该图就作为参考图；图片上的「继续生成」会新建一张已连好线的卡片；
  框选多张图后，底部可「作为参考新建 1 张卡片」或「每张图各建一张卡片」。
- 拖入图片 / 上传按钮 / Ctrl+V 粘贴都能把图片放上画布；双击图片大图预览，可下载原图。
- 提示词里用 `<Picture N>` 引用第 N 张参考图（按连线顺序编号）：输入 `@` 弹出参考图菜单（↑↓ 选择，Enter/Tab 插入，Esc 关闭），
  粘贴带 `<Picture N>` 的文字会自动显示成带缩略图的标签；点标签可替换，右下角 `</>` 切换纯文本。发给 flow2api 时换成「图片N」。
- 选中卡片或图片后，拖动边框和四角即可自由调整宽高（图片保持比例），尺寸随画板保存。
- 任务在服务端运行：关掉页面也不丢，重新打开会继续显示进度和结果。
- 多人并发：每张卡片的每一张图都是独立任务并行发给 flow2api；flow2api 的全局并发闸门
  （`[generation] image_max_concurrency`）负责限流和排队，超出的任务会显示「排队中」。
- 每个用户的画板分开保存（输入名字即可，没有密码，仅适合可信局域网）。

## 运行

```
python -m venv venv
venv\Scripts\pip install -r requirements.txt
copy config.example.json config.json   # 填 flow2api 地址和 API Key
cd web && npm install && npm run build  # 生成 web/dist
start.bat                               # 默认 http://<本机IP>:8870
```

画板、图片、任务记录保存在 `data/`（`canvas.db` 和 `assets/`）。

## 在 config.json 里关闭选项

```json
{
  "disabled_models": ["gemini-3.1-flash-lite-image"],
  "disabled_sizes": ["4K"],
  "max_count": 2
}
```

- `disabled_models`：按模型系列 key 关闭模型（key 见 `/api/models`），界面里不再显示，接口也会拒绝。
- `disabled_sizes`：关闭分辨率（`"1K"` / `"2K"` / `"4K"`）。
- `max_count`：一张卡片一次最多生成几张（1–8，默认 4）。
- 改完重启服务生效；画板里已经选了被关闭选项的卡片，打开时会自动改成可用的值。

## 开发

```
venv\Scripts\python -m pytest          # 后端测试（用假的 flow2api）
cd web && npm run dev                  # 前端开发服务器 :5180，/api 代理到 :8870
```

## 已知限制

- 只做图片（含 2K/4K，按模型选择）；视频和其他平台未接入。
- 没有账号体系；同一个名字就是同一个人。
- 同时生成的数量受 flow2api 的 Google 账号额度和并发闸门限制，积分是共享的。
