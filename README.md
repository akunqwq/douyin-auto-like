# 抖音自动点赞

一个用于网页版抖音的 Tampermonkey 用户脚本，通过模拟快捷键减少手动点赞操作，并自动跳过已点赞的视频。

## 特性

- 自动点赞当前正在观看的未点赞视频，覆盖推荐流、搜索结果、精选、播放页等页面。
- 已点赞的视频直接跳过（`data-e2e-state` 确认为已赞），不会误取消赞。
- 每个视频只处理一次：与上一个视频相同、或命中今日历史记录的，自动忽略。
- 通过模拟快捷键（Z）在浏览器端触发交互，不直接请求抖音接口。
- 刷到即赞，无额外等待。
- 可将今日刷到并点赞过的视频导出为 JSON，方便回看。


## 导出今日记录

Tampermonkey 菜单 →「导出今日记录 (JSON)」，会下载 `dy-auto-like-YYYY-MM-DD.json`，内容形如：

```json
{
  "date": "2026-10-27",
  "exportedAt": "2026-10-27 21:30:11",
  "total": 2,
  "videos": [
    {
      "index": 1,
      "time": "21:12:03",
      "id": "7xxxxxxxxxxxxxxxxxx",
      "url": "https://www.douyin.com/video/7xxxxxxxxxxxxxxxxxx"
    },
    {
      "index": 2,
      "time": "21:15:48",
      "id": "7yyyyyyyyyyyyyyyyyy",
      "url": "https://www.douyin.com/video/7yyyyyyyyyyyyyyyyyy"
    }
  ]
}
```

`id` 取自 `feed-active-video` 上的 `data-e2e-vid`，取不到时依次使用 `video-info` 上的 `data-e2e-aweme-id` 和 URL 上的 `modal_id`；`url` 可直接打开对应视频。记录按天保存，跨天自动清零。

## 界面预览


![自动点赞工作面板](image-1.png)

## 温馨提示

抖音的「喜欢」会影响后续给你推什么内容，如替自己连续点了不少喜欢，之后刷到的内容也会发生变化。
具体会有什么影响不好说，介意的话，请谨慎使用本脚本。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展（Chrome、Edge、Firefox 等）。
2. 点击下方链接，Tampermonkey 弹出安装确认页后，点击「安装」。

   [点击安装脚本](https://raw.githubusercontent.com/akunqwq/douyin-auto-like/main/douyin-auto-like.user.js)

如果没有自动弹出安装页，可以打开上述链接，复制脚本源码，再进入 Tampermonkey 的「添加新脚本」页面，粘贴并保存。

## 免责声明

本项目仅用于个人学习与浏览器自动化实验。脚本通过浏览器端操作触发交互，不主动请求抖音接口。

自动化操作可能违反目标网站的用户协议，请在使用前自行了解相关规则，并评估相应风险。请勿将本脚本用于刷量、养号等商业用途。使用本脚本产生的账号限制、封禁及其他损失，由使用者自行承担相应风险。

## 已知限制：不支持抖音页面内小窗

目前脚本面向抖音网页版的推荐流、搜索结果、精选、播放页等常规页面，抖音页面内的小窗模式尚未适配。

### 调查记录

通过devtools观察，我们可以看到：

- 小窗窗口的 URL 为 `about:blank`，`window === window.top` 为 `true`，且 `window.opener` 存在并可以访问原始抖音页面。
- 正常推荐流中的视频位于 `[data-e2e="feed-active-video"]` 容器内，并可读取 `data-e2e-vid`。
- 搜索结果页点开视频后，活动项位于 `[data-e2e="modal-video-container"]` 内（`id="dy-modal-video-container-search_multi_modal"`）。此时页面上会有 2 个 `feed-active-video`（背景推荐流 + 浮层），脚本取浮层内的那个。
- 抖音精选页的活动项位于 `[data-e2e="slideList"]` 内。
- 点赞按钮为 `[data-e2e="video-player-digg"]`，未赞 `data-e2e-state="video-player-no-digged"`，已赞 `data-e2e-state="video-player-is-digged"`。已赞时按钮会额外带上构建生成的 class（如 `Fw5w6T_O`），会随发版变化，不可用于判断。
- 播放器 class 不可靠：暂停时 `xgplayer-playing` 依然存在，会与 `xgplayer-pause`、`xgplayer-inactive` 同时出现，不能作为「正在播放」的依据。
- 视频 id 的备用来源：`[data-e2e="video-info"]` 上的 `data-e2e-aweme-id`，以及 URL 上的 `modal_id`。
- 进入小窗后，该容器在小窗文档中不存在，视频位于 `xg-video-container` 内。
- 正常推荐流与小窗中观察到相同的 `data-xgplayerid`、`blob:` 媒体地址和视频时长。这些现象提示播放器或媒体状态可能具有连续性，但尚不足以证明底层播放器实例始终相同。
- 当前小窗文档中没有脚本的悬浮面板。现有脚本使用的 `@match https://www.douyin.com/*` 不匹配 `about:blank`，因此不能假定脚本会自动在小窗中运行。

### 暂不适配的原因

现有实现依赖正常推荐流的活动视频容器和相关视频标识。小窗具有独立的文档上下文，DOM 结构也不同。仅修改视频选择器不足以保证倒计时连续、视频去重和点赞状态判断正确。

因此，当前版本暂不支持小窗模式。正常推荐流功能不受影响。

以上结论来自特定浏览器环境下的控制台观察，不代表抖音所有版本和小窗实现均具有完全相同的内部结构。

## 最后

如果本工具能帮到你，欢迎到 issues 讨论 ！

## 许可证

本项目采用 [MIT License](LICENSE) 许可。
