// 「周边 Git 项目」扫描（Git 面板下拉用，见 apps/desktop/src/main/git/scanRepos.ts）

/** 一项扫描结果：up=0 且 rel 为空 = 当前目录；up=0 且 rel 非空 = 子目录；up>0 = 第几层上级 */
export interface GitRepoHit {
  path: string       // 绝对路径
  name: string       // 目录名
  rel: string        // 相对当前目录的路径（子目录用，如 projects/other；其它为空）
  up: number         // 往上第几层（0 = 当前目录 / 子目录）
}
