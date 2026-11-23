import glob,json,subprocess,os
for d in sorted(glob.glob(os.path.abspath("series")+"/*")):
    out=subprocess.run(["python3","runner.py","score",d],capture_output=True,text=True).stdout
    try: s=json.loads(out)
    except Exception: print(d,"no score"); continue
    afters=len(glob.glob(d+"/memory-after-*"))
    print(f"{d:40} bank nights={len(s['nights'])} memory snapshots={afters} empty={[n['night'] for n in s['nights'] if not n['rounds']]}")
