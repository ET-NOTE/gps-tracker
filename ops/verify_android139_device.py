"""Opt-in ADB functional check against the synthetic tool/report_compat_smoke APK.

Usage: python verify_android139_device.py SERIAL OUT_DIR
Only writes android139.* fixtures in the selected Android139 test directory.
Never logs in, resets app data, or sends a shared file to another app/contact.
"""
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

serial,out=sys.argv[1],Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
verify_existing = '--verify-existing' in sys.argv[3:]
def adb(*args):return subprocess.check_output(['adb','-s',serial,*args],timeout=30)
def ui():
    adb('shell','uiautomator','dump','/sdcard/android139-ui.xml')
    return ET.fromstring(adb('shell','cat','/sdcard/android139-ui.xml'))
def tap(text=None,resource=None):
    for attempt in range(4):
        root=ui()
        for node in root.iter('node'):
            label=node.get('text') or node.get('content-desc') or ''
            if (text and (label==text or label.startswith(text+'\n'))) or (resource and node.get('resource-id')==resource):
                x1,y1,x2,y2=map(int,re.findall(r'\d+',node.get('bounds')))
                adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2));return
        time.sleep(.5)
    raise AssertionError(f'Control absent: {text or resource}')
def screenshot(name):
    adb('shell','screencap','-p','/sdcard/android139-screen.png')
    adb('pull','/sdcard/android139-screen.png',str(out/name))
def status(expected):
    for attempt in range(5):
        root=ui()
        labels=[n.get('text','')+' '+n.get('content-desc','') for n in root.iter('node')]
        if any(f'status: {expected}' in x for x in labels):return
        time.sleep(.5)
    raise AssertionError(f'Status absent: {expected}')

fixtures=json.loads(Path('gps-tracker-web/tests/fixtures/android-files.json').read_text(encoding='utf-8'))
assert any('EXPORT JSON' in (n.get('text','')+n.get('content-desc','')) for n in ui().iter('node')), 'Synthetic harness required'
result={'model':adb('shell','getprop','ro.product.model').decode().strip(),
        'android':adb('shell','getprop','ro.build.version.release').decode().strip(),'files':[]}
for fixture in fixtures:
    ext=fixture['filename'].rsplit('.',1)[1]
    if not verify_existing:
        tap('EXPORT '+ext.upper());tap('파일로 저장')
        root=ui()
        # Android remembers the test folder after the first selection.
        if any(n.get('text')=='android139-evidence' and n.get('resource-id')=='android:id/title' for n in root.iter('node')):
            tap('android139-evidence')
        assert any(n.get('text')=='android139-evidence' for n in ui().iter('node')), 'Select android139-evidence directory before saving'
        if ext=='json':screenshot('02-json-document-picker.png')
        tap(resource='android:id/button1');status('saved')
    actual=adb('exec-out','cat',f'/sdcard/Download/android139-evidence/android139.{ext}')
    expected=base64.b64decode(fixture['base64'])
    assert actual==expected,ext
    result['files'].append({'format':ext,'mime':fixture['mime'],'bytes':len(actual),'sha256':hashlib.sha256(actual).hexdigest(),'saved_bytes_equal':True})
    print('PASS '+('previously saved' if verify_existing else 'save')+' and byte equality:',ext,flush=True)
    if ext=='json' and not verify_existing:screenshot('03-json-saved.png')
tap('EXPORT PNG');tap('공유')
time.sleep(1)
adb('shell','input','keyevent','KEYCODE_BACK');status('share_opened')
screenshot('04-share-opened-result.png');result['share_opened_not_sent']=True
tap('EXPORT JSON');tap('취소');status('cancelled')
screenshot('05-export-cancelled.png');result['bottom_sheet_cancelled']=True
tap('EXPORT JSON');tap('파일로 저장')
# Back navigates out of the selected folder before it closes DocumentsUI.
for attempt in range(4):
    adb('shell','input','keyevent','KEYCODE_BACK')
    if any('status: cancelled' in (n.get('text','')+n.get('content-desc','')) for n in ui().iter('node')):break
status('cancelled')
result['document_picker_cancelled']=True
result['verified_existing_files']=verify_existing
(out/'device-files.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('PASS share opened only, both cancellation paths; no account/API changes',flush=True)
