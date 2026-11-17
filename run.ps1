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
$ClaudeErr = Join-Path $Root 'claude.err'
$Node      = 'C:\Program Files\nodejs\node.exe'
$Ego       = Join-Path $env:USERPROFILE '.local\share\ego\active_version_dir\ego-browser.exe'

$BRIEF_HOUR      = 9    # 아침 브리핑 시각
$REMIND_HOUR     = 15   # 마감 임박 알림 시각
$KEEP_BODY_DAYS  = 7    # 메일 본문(mail.md) 보관 일수
$FAIL_LIMIT      = 3    # 요약 연속 실패 허용 횟수
$PAUSE_MINUTES   = 30   # 연속 실패 시 요약 쉬는 시간
$CHUNK_SIZE      = 5    # 한 번에 요약할 메일 수
$ATTACH_MAX_HOURS = 24  # 요약이 안 돼도 첨부는 이 시간이 지나면 삭제
$COLLECT_ALERT_MIN = 10 # 수집이 이만큼(분) 계속 실패하면 알림

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
function Invoke-Ego($script, $name, $timeoutSec = 180) {
  # -Wait 은 ego-browser 가 띄운 브라우저(자식 프로세스)까지 끝나길 기다려서 멈출 수 있음 -> 이 프로세스만, 제한 시간까지만 기다림
  $p = Start-Process -FilePath $Ego -ArgumentList @('nodejs', '-e', "`"await import('$RootUrl$script')`"") `
       -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Root "$name.out") -RedirectStandardError (Join-Path $Root "$name.err")
  if (-not $p.WaitForExit($timeoutSec * 1000)) {
    try { $p.Kill() } catch {}
    Write-Log "$script 이(가) ${timeoutSec}초 안에 끝나지 않아 중단했어요"
    return -1
  }
  return $p.ExitCode
}
function Test-Flag($name) { Test-Path (Join-Path $Flags $name) }
function Set-Flag($name) { New-Item (Join-Path $Flags $name) -ItemType File -Force > $null }

# ---------- 수집 실패 추적: 10분 넘게 계속 실패하면 알림 한 번 ----------
$CollectFailFile = Join-Path $Root 'collect-fail.json'
function Register-CollectFail($why) {
  $f = Read-Json $CollectFailFile $null
  if (-not $f) { $f = [pscustomobject]@{ since = (Get-Date).ToString('o'); notified = $false } }
  if (-not $f.notified -and ((Get-Date) - [datetime]$f.since).TotalMinutes -ge $COLLECT_ALERT_MIN) {
    Show-Toast '메일 수집이 멈췄어요' "$([int]((Get-Date) - [datetime]$f.since).TotalMinutes)분째 메일을 못 가져오고 있어요. ego 브라우저가 켜져 있는지 확인해 주세요.`n$why" $null
    $f.notified = $true
    Write-Log '수집 중단 알림'
  }
  Save-Json $CollectFailFile $f
}
function Clear-CollectFail {
  if (Test-Path $CollectFailFile) {
    $f = Read-Json $CollectFailFile $null
    Remove-Item $CollectFailFile -Force
    if ($f -and $f.notified) { Show-Toast '메일 수집이 다시 돼요' '밀린 메일을 이어서 가져와요.' $null }
    Write-Log '수집 복구'
  }
}

# ---------- 1) 수집 (토큰 사용 없음) ----------
function Invoke-Collect {
  $resultFile = Join-Path $Root 'last-result.json'
  if (Test-Path $resultFile) { Remove-Item $resultFile -Force }
  $code = Invoke-Ego 'collect.mjs' 'collect'
  if (-not (Test-Path $resultFile)) { Write-Log "수집 실패(exit $code): $((Get-Content (Join-Path $Root 'collect.err') -Raw -Encoding UTF8))"; Register-CollectFail "수집 스크립트가 끝나지 않았어요(ego 브라우저가 꺼졌을 수 있어요)"; return $null }
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
  if (-not $res.ok) { Write-Log "수집 오류: $($res.message)"; Register-CollectFail $res.message; return $res }
  Clear-CollectFail
  if ($res.newMails.Count -gt 0) {
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

  $template = Get-Content (Join-Path $Root 'summarize-prompt.md') -Raw -Encoding UTF8
  $chunkFile = Join-Path $Root 'pending-chunk.json'
  $workAll = @(); $tasksAll = 0; $promoAll = 0; $doneCount = 0; $dangerAll = @()

  # 한 번에 너무 많이 넘기지 않도록 5통씩 나눠 요약 (하나가 실패해도 앞에서 끝난 묶음은 그대로 반영)
  for ($i = 0; $i -lt $items.Count; $i += $CHUNK_SIZE) {
    $chunk = @($items[$i..([Math]::Min($i + $CHUNK_SIZE, $items.Count) - 1)])
    [IO.File]::WriteAllText($chunkFile, (ConvertTo-Json @($chunk) -Depth 4), [Text.UTF8Encoding]::new($false))

    $seriesCtx = (& $Node (Join-Path $Root 'build.js') series-context 2>$null | Out-String).Trim()
    if (-not $seriesCtx) { $seriesCtx = '(아직 없음)' }
    $threadCtx = (& $Node (Join-Path $Root 'build.js') thread-context $chunkFile 2>$null | Out-String).Trim()
    if (-not $threadCtx) { $threadCtx = '(없음)' }
    $prompt = $template.Replace('{{TODAY}}', ('{0:yyyy-MM-dd (ddd)}' -f (Get-Date))).Replace('{{SERIES}}', $seriesCtx).Replace('{{THREADS}}', $threadCtx).Replace('{{USER_LABEL}}', $Cfg.userLabel).Replace('{{USER_NAME}}', $Cfg.userName) + "`n" + (($chunk | ForEach-Object { "- $($_.dir)" }) -join "`n")

    # 읽기 범위 제한: 작업 폴더를 inbox 로 두고 Read(./**) 만 허용 -> inbox 밖(설정·요약 데이터·사용자 파일)은 읽기 거부. Read 외 도구는 모두 금지
    Push-Location $Inbox
    $summary = $prompt | & $claude -p --allowedTools 'Read(./**)' --disallowedTools 'Bash,PowerShell,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task,Glob,Grep' --output-format text 2>$ClaudeErr | Out-String
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0 -and -not $summary.Trim() -and (Test-Path $ClaudeErr)) { $summary = (Get-Content $ClaudeErr -Raw -Encoding UTF8) }

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
      break
    }
    if ([int]$fail.count -gt 0) { Remove-Item $FailFile -Force -ErrorAction SilentlyContinue; Write-Log '요약 복구'; $fail = [pscustomobject]@{ count = 0; pausedUntil = $null } }

    $rawFile = Join-Path $Root 'last-summary.txt'
    [IO.File]::WriteAllText($rawFile, $summary, [Text.UTF8Encoding]::new($false))
    $ingest = & $Node (Join-Path $Root 'build.js') ingest $rawFile $chunkFile 2>&1 | Out-String
    if ($ingest -notmatch 'ok \d+') { Write-Log "요약 형식 오류(원문 보관): $($ingest.Trim())" }

    foreach ($it in $chunk) {
      if (Test-Path -LiteralPath $it.dir) {
        Get-ChildItem -LiteralPath $it.dir -File | Where-Object { $_.Name -like 'att_*' } | Remove-Item -Force
      }
    }
    # 끝난 묶음은 대기열에서 빼기
    $remain = @($items[($i + $chunk.Count)..($items.Count - 1)] | Where-Object { $_ })
    if ($i + $chunk.Count -ge $items.Count) { $remain = @() }
    [IO.File]::WriteAllText($Pending, (ConvertTo-Json @($remain) -Depth 4), [Text.UTF8Encoding]::new($false))
    $doneCount += $chunk.Count

    $sum = Read-Json (Join-Path $Root 'last-ingest.json') $null
    if ($sum) { $workAll += @($sum.work | ForEach-Object { $_ }); $tasksAll += [int]$sum.tasks; $promoAll += [int]$sum.promo; $dangerAll += @($sum.danger | Where-Object { $_ }) }
    else { $workAll += @($chunk | ForEach-Object { $_.subject }) }
    $dangerSet = @()
    if ($sum -and $sum.dangerUnids) { $dangerSet = @($sum.dangerUnids | Where-Object { $_ }) }

    # 그룹웨어 읽음 처리 · 의심 메일은 미확인으로 되돌려 그룹웨어에서도 눈에 띄게
    $mr = @($chunk | Where-Object { $_.openUrl -or $_.unid } | ForEach-Object {
      if ($dangerSet -contains $_.unid) { [pscustomobject]@{ unid = $_.unid; url = $_.openUrl; subject = $_.subject; unread = $true } }
      elseif ($_.openUrl) { [pscustomobject]@{ unid = $_.unid; url = $_.openUrl; subject = $_.subject } }
    } | Where-Object { $_ })
    if ($mr.Count -gt 0) {
      [IO.File]::WriteAllText((Join-Path $Root 'markread.json'), (ConvertTo-Json @($mr) -Compress -Depth 3), [Text.UTF8Encoding]::new($false))
      Invoke-Ego 'markread.mjs' 'markread' > $null
      $mres = Read-Json (Join-Path $Root 'last-markread.json') $null
      if ($mres) {
        $readRows = @($mres.results | Where-Object { -not $_.wantUnread })
        $unreadRows = @($mres.results | Where-Object { $_.wantUnread })
        if ($readRows.Count) {
          $okN = @($readRows | Where-Object { $_.read -eq $true }).Count
          $bad = @($readRows | Where-Object { $_.read -ne $true } | ForEach-Object { $_.subject })
          Write-Log ("그룹웨어 읽음 처리 {0}/{1}통{2}" -f $okN, $readRows.Count, $(if ($bad.Count) { " · 안 됨: " + ($bad -join ', ') } else { '' }))
        }
        if ($unreadRows.Count) {
          $okU = @($unreadRows | Where-Object { $_.read -ne $true -and $_.unid }).Count
          Write-Log ("의심 메일 미확인 유지 {0}/{1}통: {2}" -f $okU, $unreadRows.Count, (($unreadRows | ForEach-Object { $_.subject }) -join ', '))
        }
      }
    }
  }
  Remove-Item $chunkFile -Force -ErrorAction SilentlyContinue
  if ($doneCount -eq 0) { return }
  Write-Log "요약 완료 ${doneCount}통 -> dashboard.html, 첨부 삭제"

  # 의심 메일은 일반 알림과 따로 먼저 경고
  if ($dangerAll.Count -gt 0) {
    Show-Toast "⚠️ 의심 메일 $($dangerAll.Count)통 · 링크와 첨부를 열지 마세요" (($dangerAll -join ' / ') + "`n대시보드에서 근거를 확인하고 의심 해제 또는 위험 표시를 해 주세요.") $Dashboard
    Write-Log "의심 메일 경고: $($dangerAll -join ', ')"
  }
  # 업무 메일이 있을 때만 알림 (광고·뉴스레터만 왔으면 조용히 모아 둠)
  if ($workAll.Count -gt 0) {
    $title = "그룹웨어 새 메일 $($workAll.Count)통"
    if ($tasksAll -gt 0) { $title += " · 할 일 ${tasksAll}개" }
    Show-Toast $title ($workAll -join ' / ') $Dashboard
  } elseif ($promoAll -gt 0) {
    Write-Log "광고·뉴스레터 ${promoAll}통만 수신 - 알림 생략"
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
  # 요약이 계속 안 돼도 첨부(원본·추출 텍스트)는 24시간이 지나면 지운다
  $staleAtt = Get-ChildItem -LiteralPath $Inbox -Recurse -File -Filter 'att_*' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-$ATTACH_MAX_HOURS) }
  foreach ($f in $staleAtt) { Remove-Item -LiteralPath $f.FullName -Force }
  if ($staleAtt) { Write-Log "요약되지 않은 채 ${ATTACH_MAX_HOURS}시간 지난 첨부 $(@($staleAtt).Count)개 삭제" }
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
