# 从上一个 tag 到当前 tag 的提交生成 Release 更新日志。
# 按 Conventional Commits 前缀分组，跳过纯版本号提交；
# 输出路径由 -Output 指定，供 release.yml 的 body_path 使用。
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$Output = "release-notes.md"
)

$ErrorActionPreference = "Stop"
# 由下面的 $LASTEXITCODE 判断 git describe 是否找到上一个 tag，不让非零退出码直接终止脚本
$PSNativeCommandUseErrorActionPreference = $false

# Windows 控制台默认可能是 GBK；显式按 UTF-8 读取 git 输出，避免中文提交信息乱码
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not (git rev-parse -q --verify "refs/tags/$Tag")) {
  throw "找不到 tag：$Tag"
}

$previousTag = git describe --tags --abbrev=0 --match "v[0-9]*" "$Tag^" 2>$null
if ($LASTEXITCODE -ne 0 -or -not $previousTag) {
  $previousTag = $null
  $range = $Tag
} else {
  $range = "$previousTag..$Tag"
}

$groups = [ordered]@{
  "新功能"     = [System.Collections.Generic.List[string]]::new()
  "问题修复"   = [System.Collections.Generic.List[string]]::new()
  "性能优化"   = [System.Collections.Generic.List[string]]::new()
  "重构"       = [System.Collections.Generic.List[string]]::new()
  "构建与维护" = [System.Collections.Generic.List[string]]::new()
  "文档"       = [System.Collections.Generic.List[string]]::new()
  "测试"       = [System.Collections.Generic.List[string]]::new()
  "样式"       = [System.Collections.Generic.List[string]]::new()
  "回滚"       = [System.Collections.Generic.List[string]]::new()
  "其他"       = [System.Collections.Generic.List[string]]::new()
}

$typeToGroup = @{
  feat     = "新功能"
  fix      = "问题修复"
  perf     = "性能优化"
  refactor = "重构"
  build    = "构建与维护"
  ci       = "构建与维护"
  chore    = "构建与维护"
  docs     = "文档"
  test     = "测试"
  style    = "样式"
  revert   = "回滚"
}

git log $range --no-merges --pretty=format:"%h%x09%s" | ForEach-Object {
  $line = $_.Trim()
  if (-not $line) { return }

  $parts = $line -split "`t", 2
  if ($parts.Count -lt 2) { return }
  $hash = $parts[0]
  $subject = $parts[1]
  $scope = ""

  if ($subject -match '^(feat|fix|perf|refactor|build|ci|chore|docs|test|style|revert)(\([^)]+\))?!?:\s*(.+)$') {
    $group = $typeToGroup[$matches[1].ToLower()]
    $scope = $matches[2]
    $text = $matches[3]
  } else {
    $group = "其他"
    $text = $subject
  }

  # 版本号提交对用户没有信息量，不写进更新日志
  if ($text -match '版本号?[为至]\s*\d|bump version') { return }

  if ($scope) {
    $scope = $scope.Trim("(", ")")
    $text = "**${scope}**：${text}"
  }
  $groups[$group].Add("- ${text} (${hash})")
}

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("## 更新内容")
$hasEntries = $false
foreach ($group in $groups.Keys) {
  if ($groups[$group].Count -eq 0) { continue }
  $hasEntries = $true
  $lines.Add("")
  $lines.Add("### $group")
  foreach ($item in $groups[$group]) { $lines.Add($item) }
}
if (-not $hasEntries) {
  $lines.Add("")
  $lines.Add("- 本次发布没有新的代码提交。")
}
if ($previousTag -and $env:GITHUB_REPOSITORY) {
  $lines.Add("")
  $lines.Add("**完整变更**：https://github.com/$env:GITHUB_REPOSITORY/compare/$previousTag...$Tag")
}

$content = $lines -join "`n"
$outputPath = if ([System.IO.Path]::IsPathRooted($Output)) {
  $Output
} else {
  Join-Path (Get-Location) $Output
}
[System.IO.File]::WriteAllText(
  $outputPath,
  $content,
  [System.Text.UTF8Encoding]::new($false)
)
Write-Host "已生成 $Output（$range）"
