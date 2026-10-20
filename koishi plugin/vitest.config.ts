import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    /**
     * 测试里把 `koishi` 指到 `@koishijs/core`。
     *
     * `koishi` 主入口 = `@koishijs/core` + `@koishijs/loader`（CLI/启动器），
     * 而 loader 的产物里有 `import Loader from './shared.js'` 这种
     * 「ESM 引 CJS」的相对导入，在 Vite 的转换管线里会被解析成
     * `Class extends value #<Object> is not a constructor` 而直接炸掉。
     *
     * 插件真正用到的 `Context` / `Schema` / `h` 与全部类型都来自 core，
     * 所以测试环境指向 core 即可 —— 生产环境加载的仍是完整的 koishi。
     * 用正则精确锚定，避免误伤 `koishi-plugin-*` 这类包名。
     */
    alias: [
      { find: /^koishi$/, replacement: '@koishijs/core' },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    // 谱面渲染要下载并绘制音符，首次调用可能几十秒
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
