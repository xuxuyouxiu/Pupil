# -*- coding: utf-8 -*-
"""发布产物同步到阿里云 OSS（GitHub Actions 中运行）—— 与 PodMuse 同仓同 bucket 复用

把 release/ 下的安装包 / blockmap / latest.yml 上传到 download/v{version}/：
- 安装包与 blockmap 内容不可变 → Cache-Control 长缓存
- latest.yml 是更新探测入口 → no-cache（必须永远拿到最新）
密钥从环境变量读取（仓库 Secrets：OSS_AK_ID / OSS_AK_SECRET / OSS_ENDPOINT，
与 PodMuse 仓库同名同值，bucket 复用 podmuse，路径按项目区分互不干扰）；
Secrets 未配置时警告并跳过（退出码 0），不阻塞 Release 流程。
"""
import json
import os
import sys


def main() -> None:
    ak = os.environ.get("OSS_AK_ID", "")
    sk = os.environ.get("OSS_AK_SECRET", "")
    endpoint = os.environ.get("OSS_ENDPOINT", "")
    bucket_name = os.environ.get("OSS_BUCKET", "podmuse")

    if not (ak and sk and endpoint):
        print("[sync-oss] OSS Secrets 未配置（OSS_AK_ID/OSS_AK_SECRET/OSS_ENDPOINT），跳过同步")
        return

    try:
        import oss2
    except ImportError:
        sys.exit("[sync-oss] 缺少依赖：请先 pip install oss2")

    version = json.load(open("package.json", encoding="utf-8"))["version"]
    auth = oss2.Auth(ak, sk)
    bucket = oss2.Bucket(auth, endpoint, bucket_name)

    dist = "release"
    targets = [
        (f"Pupil-{version}-x64.exe", "max-age=31536000, immutable"),
        (f"Pupil-{version}-x64.exe.blockmap", "max-age=31536000, immutable"),
        (f"Pupil-{version}-portable.exe", "max-age=31536000, immutable"),
        ("latest.yml", "no-cache"),
    ]

    # v1.0.5 顺序优化：latest.yml 最先上传（缩小应用内 feed 的过期窗口）
    for fname, cache in targets:
        local = os.path.join(dist, fname)
        if not os.path.exists(local):
            sys.exit(f"[sync-oss] 缺少构建产物: {local}")
        key = f"download/v{version}/{fname}"
        bucket.put_object_from_file(key, local, headers={"CacheControl": cache})
        print(f"[sync-oss] OK {key}")

    # v1.0.0 固定目录副本（exe/blockmap + latest.yml 同目录）：
    # electron-updater generic provider 以 latest.yml 所在目录解析相对文件 URL，
    # 该目录即应用内更新的首选 feed（差量更新依赖同目录 blockmap）。
    # v1.0.5 改服务端复制（同 bucket 内秒级完成），取代 170MB 的跨洋二次上传
    for fname, cache in targets:
        key = f"download/pupil/{fname}"
        bucket.copy_object("podmuse", f"download/v{version}/{fname}", key)
        print(f"[sync-oss] OK(copy) {key}")

    # 固定路径副本（不带版本号）：供官网/外部探测「最新版本号」
    bucket.copy_object("podmuse", f"download/v{version}/latest.yml", "download/pupil/latest.yml")
    print("[sync-oss] OK download/pupil/latest.yml")

    # 校验 latest.yml 可读且含版本号（防传错文件）
    obj = bucket.get_object(f"download/v{version}/latest.yml")
    head = obj.read(256).decode("utf-8", errors="replace")
    if f"version: {version}" not in head:
        sys.exit("[sync-oss] latest.yml 内容校验失败（版本号不符）")
    print(f"[sync-oss] DONE 版本 {version} 已同步至 OSS")


if __name__ == "__main__":
    main()
