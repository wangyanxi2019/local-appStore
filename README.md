# 本地 iOS IPA 分发平台 (Local AppStore)

## 💡 项目使用场景

本项目主要用于将 Mac 电脑作为本地的 iOS IPA 分发服务器。开发者可以通过该网页平台直接上传并管理 iOS 的 IPA 安装包，平台会自动解析包信息并生成带安装二维码的网页。
使用 iOS 设备扫描二维码，即可直接在局域网内或通过网络穿透（如 ngrok）完成应用的无线安装，极大提升了测试和分发效率。

主要适用场景：
- 🏢 **企业内部分发**：为企业员工快速分发内部应用。
- 🧪 **团队研发测试**：在开发人员和 QA 测试人员之间快速流转每日构建的测试包。
- 👨‍💻 **个人开发调试**：避免繁琐的连线，快速在多台测试机上安装并验证 App。
- 👨‍💻 **安全！安全**：不上传任何数据到云端，所有数据都在本地。
---

## 📸 界面预览

![应用列表](./image/1.png)

![安装页面](./image/2.png)

![上传页面](./image/3.png)

---

# 本地机器部署指南

在另一台 Mac（如新 Mac mini）上部署本 iOS IPA 分发服务，按下面步骤即可。

---

## 一、环境要求

- **Node.js**：建议 25.2.1（推荐用 [nvm](https://github.com/nvm-sh/nvm) 或官网安装）

  ```
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  ```

  ```
  source ~/.zshrc
  ```

  ```
  nvm -v
  ```

  ```
  nvm install 25.2.1
  ```

  ```
  nvm use 25.2.1
  ```

  

- **npm**：随 Node 自带即可

检查版本：
```bash
node -v   # 建议 >= 18
npm -v
```

---

## 二、拿到项目代码

1. **从旧机拷贝整个项目文件夹**  
   - 用 U 盘、网盘或 `scp` 把整个 `ios-ipa-distribution-platform` 目录拷到新机  
   - 新机打开终端，`cd` 到该目录

---

## 三、安装依赖

在新机项目根目录执行：

```bash
npm install
```

（会安装 `package.json` 里所有依赖，包含 ngrok、better-sqlite3 等。）

---

## 四、环境配置（可选）

- **不创建 .env**：服务会默认用本机局域网 IP + 自签名 HTTPS（手机需在 Safari 里信任证书）。
- **需要自定义或固定地址时**：在项目根目录创建 `.env`，参考 `.env.example`：

```bash
cp .env.example .env
# 按需编辑 .env
```

常用项：

| 变量 | 说明 |
|------|------|
| `APP_URL` | 对外访问地址。用自签名证书时填 `https://本机IP:3000`（如 `https://192.168.10.219:3000`）。用 ngrok 时可不填。 |
| `USE_NGROK=1` | 仅在用「ngrok 模式」时在启动命令里加，一般不必写在 .env。 |
| `GEMINI_API_KEY` | 仅在使用 Gemini 相关功能时需要。 |

---

## 五、启动服务方式

在项目根目录：

| 场景 | 命令 | 说明 |
|------|------|------|
| 本机 + 局域网访问 | `npm run dev` | HTTPS 自签名，手机需在 Safari 信任证书后扫码安装。（无限速，地址固定） |
| 手机扫码安装（推荐） | `npm run dev:ngrok` | 自动起 ngrok 隧道，用临时 HTTPS 域名，无需信任证书；启动后刷新浏览器再扫码。（有限速，地址随机） |

首次用 ngrok 时，需先配置 authtoken（一次性）：

```bash
# 1. 打开 https://dashboard.ngrok.com/signup 注册
# 2. 在 https://dashboard.ngrok.com/get-started/your-authtoken 复制 authtoken（一长串字符）
# 3. 在终端执行（把下面的 YOUR_AUTHTOKEN 替换成你复制的整段 token）：
```

然后安装执行：

```
brew install ngrok
```

```
ngrok config add-authtoken YOUR_AUTHTOKEN
```



```bash
npm run dev:ngrok
```

终端出现 `ngrok tunnel (HTTPS): https://xxx.ngrok-free.app` 后，在浏览器**刷新**管理页，再用手机扫页面上的二维码安装。

---

## 六、数据与文件（换机要带上的）

本服务**无 MySQL**，数据都在项目目录下，换机时若要「原样迁移」请一并拷贝：

| 路径 | 说明 |
|------|------|
| `data.db` | SQLite 数据库（应用与版本信息）。 |
| `uploads/` | 上传的图标和 IPA 文件（`uploads/icons/`、`uploads/ipas/`）。 |

- 若**不拷贝**：新机是全新库和空上传目录，需要重新创建应用、上传 IPA。
- 若**要保留**：把旧机上的 `data.db` 和整个 `uploads/` 拷到新机同一项目目录下，再启动服务即可。

---

## 七、一键检查清单（新机执行）

```bash
# 1. 进入项目
cd /path/to/ios-ipa-distribution-platform

# 2. 安装依赖
npm install

# 3. （可选）从旧机拷贝 data.db 和 uploads/ 后再启动

# 4. 启动（二选一）
npm run dev        # 本机 + 局域网，自签名 HTTPS
npm run dev:ngrok  # 推荐：ngrok 临时 HTTPS，手机直接扫码安装
```

本机管理后台：浏览器打开 **http://localhost:3000**（用 ngrok 时也可用终端里打印的 ngrok 地址）。

---

## 八、清理列表数据

在项目根目录执行。

**只清空应用/版本记录（保留已上传的图标和 IPA 文件）：**
```bash
rm -f data.db
```

**彻底清空：列表 + 所有上传的图标和 IPA：**
```bash
rm -f data.db
rm -rf uploads
```
执行后需**重启服务**；重启后会自动生成新的空 `data.db`，以及 `uploads/icons`、`uploads/ipas` 目录。

---

## 九、无法安装 app：可能原因与处理

| 现象 / 原因 | 处理办法 |
|-------------|----------|
| **无法连接 localhost** | 手机访问不到电脑的 localhost。用 `npm run dev:ngrok` 获取 HTTPS 地址，或在本机设置 `APP_URL=https://本机IP:3000`（与手机同一 WiFi）。 |
| **证书无效 / 不受信任** | 用 **ngrok**：`npm run dev:ngrok`，用生成的 `https://xxx.ngrok-free.app` 扫码，一般无需信任证书。若用本机 HTTPS：在手机 Safari 先打开该地址并接受证书，再扫码安装。 |
| **提示「无法安装，请稍后再试」** | 多为 manifest 或 IPA 下载异常。确认：① 用 ngrok 或 HTTPS 访问；② 重启服务后刷新浏览器再生成二维码；③ 同一 WiFi、无代理/VPN 干扰。 |
| **IPA 签名 / 描述文件问题** | **开发包 / Ad Hoc**：当前设备的 UDID 必须在描述文件中，且未超设备数限制。**企业包**：企业证书和描述文件需有效、未过期。在 Xcode/开发者网站检查描述文件与设备列表。 |
| **设备已装过同 Bundle ID 的旧版** | 在 iPhone：设置 → 通用 → VPN 与设备管理，删除旧描述文件或先卸载旧应用，再重新扫码安装。 |
| **网络 / 环境** | 手机和运行服务的电脑在同一 WiFi；若用 ngrok，启动后等隧道就绪再刷新页面、再扫码。 |

优先用 **`npm run dev:ngrok`** 并刷新页面后扫码，可排除大部分「无法连接」「证书无效」类问题；若仍失败，多半是 **IPA 签名或描述文件** 与当前设备不匹配，需在苹果开发者后台或 Xcode 里核对。

---

## 十、常见问题

- **手机提示无法连接 / 证书无效**  
  - 用 `npm run dev:ngrok` 获得临时 HTTPS 域名，一般可避免证书问题。  
  - 若用 `npm run dev`，需在手机 Safari 先打开 `https://本机IP:3000` 并信任证书，再扫码。

- **无法安装 app（综合排查）**  
  - 见**第九节「无法安装 app：可能原因与处理」**。

- **ngrok 报 "tunnel already exists"**  
  - 已改为直接跑 ngrok 二进制，一般不会出现；若仍有，先执行 `pkill -f ngrok` 再重新 `npm run dev:ngrok`。

- **Vite 报 host not allowed**  
  - 已在 `vite.config.ts` 中设置 `server.allowedHosts: true`，用 ngrok 域名访问不会被拦截；若仍报错，确认已重启 `npm run dev:ngrok`。

- **端口被占用 `EADDRINUSE: address already in use 0.0.0.0:3000`**  
  先杀掉占用端口的进程，再重新启动：

  ```bash
  # 一键杀掉 3000 和 24678 端口上的进程
  lsof -ti :3000 | xargs kill -9 2>/dev/null; lsof -ti :24678 | xargs kill -9 2>/dev/null; echo "done"
  ```

  ```bash
  # 然后重新启动
  npm run dev:ngrok
  ```

按上述步骤在新 Mac mini 上即可部署并运行同一套服务；数据与上传文件记得按需拷贝 `data.db` 和 `uploads/`。清理数据见**第八节**。
