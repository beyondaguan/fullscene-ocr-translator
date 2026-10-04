# 彻底关闭/卸载 Windows Defender（管理员 PowerShell）

## 现状（本机实测）

- 实时保护：已关（`RealTimeProtectionEnabled = False`）
- 篡改防护：已关（`IsTamperProtected = False`）
- 路径排除：已加（`D:\g`、`D:\g\ct2rs-clean`、`D:\g\fullscene-ocr-translator`）
- `WdNisSvc`（网络检查）：**已停止**
- `WinDefend`（主服务）：**仍在运行，命令行无法停止**

`WinDefend` 的服务注册表项 `HKLM\SYSTEM\CurrentControlSet\Services\WinDefend`
所有者是 `SYSTEM`，且 Defender 运行时会给 Administrators 加 `Deny` ACE，
导致 `sc stop` / `Set-ItemProperty` / `taskkill` 全部返回「拒绝访问」。

**结论：命令行到此为止，必须走图形界面或卸载。**

---

## 方案 A：图形界面关闭（推荐，最快）

1. `Win + I` → 设置 → 隐私和安全性 → Windows 安全中心
2. 「病毒和威胁防护」→ **管理设置**
3. 关闭以下开关（若有密码提示需输入）：
   - 实时保护
   - 篡改防护
   - 云提供的保护
   - 提交样本
4. 确认「排除项」页里有 `D:\g`

## 方案 B：组策略强制关闭

1. `Win + R` → 输入 `gpedit.msc` → 回车
2. 计算机配置 → 管理模板 → Windows 组件 → Microsoft Defender
3. 双击「关闭 Microsoft Defender 防病毒」→ 设为**已启用**
4. 同目录「关闭 Microsoft Defender 篡改防护」→ 设为**已启用**
5. 重启电脑

> 注意：Win11 家庭版没有 gpedit.msc，改用方案 A 或 C。

## 方案 C：安全模式绕过（服务锁死时唯一可靠法）

```powershell
# 1. 正常模式下先设好排除项（已做）
# 2. 持有安全模式：Win+R → msconfig → 引导 → 勾选"安全模式" → 重启
# 3. 进入安全模式后，用管理员 PowerShell 执行：
sc config WinDefend start= disabled
sc stop WinDefend
reg add "HKLM\SYSTEM\CurrentControlSet\Services\WinDefend" /v Start /t REG_DWORD /d 4 /f
# 4. 取消安全模式重启
```

安全模式下 Defender 服务不自保护，`Start=4` 会真正生效。

## 方案 D：彻底卸载 Defender（Win11 可用）

```powershell
# 管理员 PowerShell（Win11 24H2+ 支持）
Dism /Online /Remove-Package /PackageName:Microsoft-Windows-Defender-* /NoRestart
# 或用 Settings > Apps > Installed apps 里的 "Microsoft Defender" 卸载
```

---

## 恢复方法（做完构建后务必恢复）

```powershell
# 1. 恢复服务
sc config WinDefend start= auto
sc config WdNisSvc start= demand
Start-Service WdNisSvc
Start-Service WinDefend
# 2. 恢复篡改防护
Set-MpPreference -DisableTamperProtection $false
Set-MpPreference -DisableRealtimeMonitoring $false
# 3. 删除排除项
Remove-MpPreference -ExclusionPath "D:\g"
Remove-MpPreference -ExclusionPath "D:\g\ct2rs-clean"
Remove-MpPreference -ExclusionPath "D:\g\fullscene-ocr-translator"
```

---

## 现状说明

**本次构建不依赖方案 A/B/C/D 全部完成。**
实时保护已关 + 路径排除已加后，CTranslate2 源码已完整落盘（2006 文件、22/22 关键头文件校验通过），
构建正在进行中。若本次构建顺利通过，说明"实时保护扫描"就是删文件的元凶，
方案 A 的现状（实时保护关闭）已足够，后续只需保持该状态即可。

若本次构建**仍**出现头文件消失，则说明是 `WinDefend` 服务本体或其内核过滤驱动在作祟，
必须执行方案 C（安全模式改 `Start=4`）或方案 D（卸载）。
