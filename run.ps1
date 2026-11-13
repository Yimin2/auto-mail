# 그룹웨어 새 메일 확인 -> (새 메일 있을 때만) Claude 요약 -> 첨부 삭제 -> 알림
# + 아침 9시 브리핑, 오후 3시 마감 임박 알림, 본문 7일 뒤 삭제, 요약 연속 실패 시 30분 휴식
# 작업 스케줄러가 평일 08:00~19:00 1분마다 run.vbs 를 통해 숨김 실행합니다.
$ErrorActionPreference = 'Continue'
$Root      = $PSScriptRoot
$Cfg       = Get-Content (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json   # 개인 설정
$RootUrl   = ([Uri]($Root.TrimEnd('\') + '\')).AbsoluteUri
$Log       = Join-Path $Root 'run.log'
$Pending   = Join-Path $Root 'pending.json'
$Inbox     = Join-Path $Root 'inbox'
$Flags     = Join-Path $Root 'flags'
$FailFile  = Join-Path $Root 'fail.json'
$Dashboard = Join-Path $Root 'dashboard.html'
$Node      = 'C:\Program Files\nodejs\node.exe'
$Ego       = Join-Path $env:USERPROFILE '.local\share\ego\active_version_dir\ego-browser.exe'

$BRIEF_HOUR      = 9    # 아침 브리핑 시각
$REMIND_HOUR     = 15   # 마감 임박 알림 시각
$KEEP_BODY_DAYS  = 7    # 메일 본문(mail.md) 보관 일수
$FAIL_LIMIT      = 3    # 요약 연속 실패 허용 횟수
$PAUSE_MINUTES   = 30   # 연속 실패 시 요약 쉬는 시간

function Write-Log($msg) {
  $line = "{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $msg
  Add-Content -Path $Log -Value $line -Encoding UTF8
  if ((Get-Item $Log).Length -gt 2MB) { Get-Content $Log -Tail 2000 -Encoding UTF8 | Set-Content $Log -Encoding UTF8 }
}
function Show-Toast($title, $body, $openPath) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
    $e = { param($s) [Security.SecurityElement]::Escape([string]$s) }
    $launch = ''
    if ($openPath -and (Test-Path -LiteralPath $openPath)) {
      $uri = ([Uri](Resolve-Path -LiteralPath $openPath).Path).AbsoluteUri
      $launch = " activationType=`"protocol`" launch=`"$(& $e $uri)`""
    }
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml("<toast$launch><visual><binding template=`"ToastGeneric`"><text>$(& $e $title)</text><text>$(& $e $body)</text>$(if ($launch) { '<text>클릭하면 할 일 대시보드가 열립니다</text>' })</binding></visual></toast>")
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
  } catch { Write-Log "toast 실패: $_" }
}
function Find-Claude {
  foreach ($p in @($Cfg.claudePath, "$env:USERPROFILE\.local\bin\claude.exe", "$env:APPDATA\npm\claude.cmd")) { if ($p -and (Test-Path $p)) { return $p } }
  $c = Get-Command claude.cmd, claude.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  return $null
}
function Read-Json($path, $default) {
  if (-not (Test-Path -LiteralPath $path)) { return $default }
  try { return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $default }
}
function Save-Json($path, $obj) {
  [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Compress -Depth 5), [Text.UTF8Encoding]::new($false))
}
function Invoke-Ego($script, $name) {
  $p = Start-Process -FilePath $Ego -ArgumentList @('nodejs', '-e', "`"await import('$RootUrl$script')`"") `
       -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $Root "$name.out") -RedirectStandardError (Join-Path $Root "$name.err")
  return $p.ExitCode
}
function Test-Flag($name) { Test-Path (Join-Path $Flags $name) }
function Set-Flag($name) { New-Item (Join-Path $Flags $name) -ItemType File -Force > $null }

# ---------- 1) 수집 (토큰 사용 없음) ----------
function Invoke-Collect {
  $resultFile = Join-Path $Root 'last-result.json'
  if (Test-Path $resultFile) { Remove-Item $resultFile -Force }
  $code = Invoke-Ego 'collect.mjs' 'collect'
  if (-not (Test-Path $resultFile)) { Write-Log "수집 실패(exit $code): $((Get-Content (Join-Path $Root 'collect.err') -Raw -Encoding UTF8))"; return $null }
  $res = Read-Json $resultFile $null

  $loginFlag = Join-Path $Root 'login-required.flag'
  if ($res.loginRequired) {
    if (-not (Test-Path $loginFlag)) {
      Show-Toast '그룹웨어 로그인 필요' "ego 브라우저에서 $(([Uri]$Cfg.gwHost).Host) 에 다시 로그인해 주세요."
      New-Item $loginFlag -ItemType File -Force > $null
      Write-Log '로그인 필요'
    }
    return $res
  }
  if (Test-Path $loginFlag) { Remove-Item $loginFlag -Force; Write-Log '로그인 복구' }
  if (-not $res.ok) { Write-Log "수집 오류: $($res.message)" }
  elseif ($res.newMails.Count -gt 0) {
    Write-Log "새 메일 $($res.newMails.Count)통 수집"
    foreach ($rc in @($res.readCheck)) { if ($rc) { Write-Log ("  읽음상태 진단: 수집 전 {0} -> 후 {1} | {2}" -f $(if ($rc.before) {'읽음'} else {'미확인'}), $(if ($rc.after) {'읽음'} elseif ($rc.after -eq $false) {'미확인'} else {'?'}), $rc.subject) } }
  }
  return $res
}

# ---------- 2) 요약 (새 메일이 있을 때만, 연속 실패 시 쉬기) ----------
function Invoke-Summary {
  $items = @((Read-Json $Pending @()) | ForEach-Object { $_ })
  if ($items.Count -eq 0) { return }

  $fail = Read-Json $FailFile ([pscustomobject]@{ count = 0; pausedUntil = $null })
  if ($fail.pausedUntil -and (Get-Date) -lt [datetime]$fail.pausedUntil) { return }

  $claude = Find-Claude
  if (-not $claude) { Write-Log 'Claude CLI 없음 - 요약 건너뜀'; return }

  $seriesCtx = (& $Node (Join-Path $Root 'build.js') series-context 2>$null | Out-String).Trim()
  if (-not $seriesCtx) { $seriesCtx = '(아직 없음)' }
  $threadCtx = (& $Node (Join-Path $Root 'build.js') thread-context $Pending 2>$null | Out-String).Trim()
  if (-not $threadCtx) { $threadCtx = '(없음)' }
  $prompt = (Get-Content (Join-Path $Root 'summarize-prompt.md') -Raw -Encoding UTF8).Replace('{{TODAY}}', ('{0:yyyy-MM-dd (ddd)}' -f (Get-Date))).Replace('{{SERIES}}', $seriesCtx).Replace('{{THREADS}}', $threadCtx).Replace('{{USER_LABEL}}', $Cfg.userLabel).Replace('{{USER_NAME}}', $Cfg.userName) + "`n" + (($items | ForEach-Object { "- $($_.dir)" }) -join "`n")
  Push-Location $Root
  $summary = $prompt | & $claude -p --allowedTools Read --output-format text 2>&1 | Out-String
  $code = $LASTEXITCODE
  Pop-Location

  if ($code -ne 0 -or -not $summary.Trim()) {
    $count = [int]$fail.count + 1
    $msg = ($summary.Trim() -split "`n" | Select-Object -First 1)
    Write-Log "요약 실패 ${count}회째(exit $code): $msg"
    if ($count -ge $FAIL_LIMIT) {
      $until = (Get-Date).AddMinutes($PAUSE_MINUTES)
      Save-Json $FailFile ([pscustomobject]@{ count = $count; pausedUntil = $until.ToString('o') })
      Write-Log "요약 ${PAUSE_MINUTES}분 휴식 (~$($until.ToString('HH:mm')))"
      if ($count -eq $FAIL_LIMIT) {
        Show-Toast '메일 요약이 계속 실패하고 있어요' "$msg`n$($until.ToString('HH:mm'))에 다시 시도해요. 메일 수집은 계속돼요." $null
      }
    } else {
      Save-Json $FailFile ([pscustomobject]@{ count = $count; pausedUntil = $null })
    }
    return
  }
  if ([int]$fail.count -gt 0) { Remove-Item $FailFile -Force -ErrorAction SilentlyContinue; Write-Log '요약 복구' }

  $rawFile = Join-Path $Root 'last-summary.txt'
  [IO.File]::WriteAllText($rawFile, $summary, [Text.UTF8Encoding]::new($false))
  $ingest = & $Node (Join-Path $Root 'build.js') ingest $rawFile $Pending 2>&1 | Out-String
  if ($ingest -notmatch 'ok \d+') { Write-Log "요약 형식 오류(원문 보관): $($ingest.Trim())" }

  foreach ($it in $items) {
    if (Test-Path -LiteralPath $it.dir) {
      Get-ChildItem -LiteralPath $it.dir -File | Where-Object { $_.Name -like 'att_*' } | Remove-Item -Force
    }
  }
  Set-Content $Pending '[]' -Encoding UTF8
  Write-Log "요약 완료 $($items.Count)통 -> dashboard.html, 첨부 삭제"

  # 요약이 끝난 메일은 그룹웨어에서도 읽음 처리
  $mr = @($items | Where-Object { $_.openUrl } | ForEach-Object { [pscustomobject]@{ unid = $_.unid; url = $_.openUrl; subject = $_.subject } })
  if ($mr.Count -gt 0) {
    [IO.File]::WriteAllText((Join-Path $Root 'markread.json'), (ConvertTo-Json @($mr) -Compress -Depth 3), [Text.UTF8Encoding]::new($false))
    Invoke-Ego 'markread.mjs' 'markread' > $null
    $mres = Read-Json (Join-Path $Root 'last-markread.json') $null
    if ($mres) {
      $okN = @($mres.results | Where-Object { $_.read -eq $true }).Count
      $bad = @($mres.results | Where-Object { $_.read -ne $true } | ForEach-Object { $_.subject })
      Write-Log ("그룹웨어 읽음 처리 {0}/{1}통{2}" -f $okN, $mr.Count, $(if ($bad.Count) { " · 안 됨: " + ($bad -join ', ') } else { '' }))
    }
  }

  $sum = Read-Json (Join-Path $Root 'last-ingest.json') $null
  if ($sum) {
    $work = @($sum.work | ForEach-Object { $_ })
    if ($work.Count -gt 0) {
      $title = "그룹웨어 새 메일 $($work.Count)통"
      if ($sum.tasks -gt 0) { $title += " · 할 일 $($sum.tasks)개" }
      Show-Toast $title ($work -join ' / ') $Dashboard
    } else {
      Write-Log "광고·뉴스레터 $($sum.promo)통만 수신 - 알림 생략"
    }
  } else {
    Show-Toast "그룹웨어 새 메일 $($items.Count)통" (($items | ForEach-Object { $_.subject }) -join ' / ') $Dashboard
  }
}

# ---------- 3) 아침 브리핑 · 마감 임박 알림 (하루 한 번씩) ----------
function Get-Brief {
  Invoke-Ego 'marks.mjs' 'marks' > $null   # 대시보드 체크 기록 읽기
  & $Node (Join-Path $Root 'build.js') brief > $null 2>&1
  return Read-Json (Join-Path $Root 'last-brief.json') $null
}
function Invoke-Reminders {
  $now = Get-Date
  $d = $now.ToString('yyyyMMdd')
  if ($now.DayOfWeek -in 'Saturday', 'Sunday') { return }

  if ($now.Hour -ge $BRIEF_HOUR -and -not (Test-Flag "brief-$d")) {
    Set-Flag "brief-$d"
    $b = Get-Brief
    if ($b) {
      $urgent = @($b.overdue).Count + @($b.dueToday).Count
      $title = "좋은 아침이에요 · 남은 할 일 $($b.open)개"
      $lines = @()
      if (@($b.overdue).Count)  { $lines += "마감 지남 $(@($b.overdue).Count)건: $(@($b.overdue) -join ', ')" }
      if (@($b.dueToday).Count) { $lines += "오늘 마감 $(@($b.dueToday).Count)건: $(@($b.dueToday) -join ', ')" }
      if ($b.suspicious)        { $lines += "확인할 의심 메일 $($b.suspicious)통" }
      if (-not $lines.Count)    { $lines += '오늘 마감인 일은 없어요.' }
      Show-Toast $title ($lines -join "`n") $Dashboard
      Write-Log "아침 브리핑: 남은 $($b.open), 긴급 $urgent, 체크기록 $(if ($b.marksOk) {'반영'} else {'못 읽음'})"
    }
  }

  if ($now.Hour -ge $REMIND_HOUR -and -not (Test-Flag "remind-$d")) {
    Set-Flag "remind-$d"
    $b = Get-Brief
    if ($b) {
      $list = @($b.overdue) + @($b.dueToday) | Where-Object { $_ }
      if ($list.Count -gt 0) {
        Show-Toast "아직 처리하지 않은 오늘 마감 $($list.Count)건" ($list -join "`n") $Dashboard
        Write-Log "마감 임박 알림: $($list.Count)건"
      }
    }
  }
}

# ---------- 4) 정리: 본문 7일 뒤 삭제, 오래된 플래그 삭제 (한 시간에 한 번) ----------
function Invoke-Cleanup {
  $h = (Get-Date).ToString('yyyyMMddHH')
  if (Test-Flag "cleanup-$h") { return }
  Get-ChildItem $Flags -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-3) } | Remove-Item -Force
  Set-Flag "cleanup-$h"
  $busy = @((Read-Json $Pending @()) | ForEach-Object { ($_.dir -replace '/', '\').TrimEnd('\') })
  $cut = (Get-Date).AddDays(-$KEEP_BODY_DAYS)
  $old = Get-ChildItem -LiteralPath $Inbox -Directory -ErrorAction SilentlyContinue |
         Where-Object { $_.CreationTime -lt $cut -and ($busy -notcontains $_.FullName.TrimEnd('\')) }
  foreach ($dir in $old) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force }
  if ($old) { Write-Log "본문 보관기간(${KEEP_BODY_DAYS}일) 지난 메일 폴더 $(@($old).Count)개 삭제" }
}

# ---------- 실행 ----------
$mutex = New-Object System.Threading.Mutex($false, 'Global\gw-mail-run')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $OutputEncoding = [Text.Encoding]::UTF8
  New-Item $Flags -ItemType Directory -Force > $null

  $res = Invoke-Collect
  if ($res -and $res.ok) { Invoke-Summary }
  Invoke-Reminders
  Invoke-Cleanup
} catch {
  Write-Log "오류: $_"
} finally {
  $mutex.ReleaseMutex()
}
