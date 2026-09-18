// Worker 运行时绑定。单一 R2 bucket 同时存放「社区名单快照」与「公开关键词词库」。
// 自托管场景（单人使用）不需要 D1 / 后台 / 定时任务：名单与词库都是仓库里
// 预审过的静态产物，由 scripts/publish.sh 上传到 R2 即可。
declare namespace Cloudflare {
  interface Env {
    DATA: R2Bucket;
  }
}
