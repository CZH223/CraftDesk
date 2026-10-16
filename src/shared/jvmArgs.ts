/**
 * 让 JVM 用 UTF-8 往控制台 / 管道写字的参数。
 *
 * 不传这几个参数时，Java 用系统编码（中文 Windows 上是 GBK/936）输出，
 * 而 CraftDesk 和 MCDReforged 都按 UTF-8 解码。结果分两种，都很难查：
 *
 * - 中文变成乱码：「正在启动服务器」显示成一串问号
 * - 干脆报错：MCDR 会把读不懂的那行丢掉并记一条 UnicodeDecodeError。
 *   服务器目录名里有中文时，Java 打印的 classpath 里就带着中文路径，
 *   所以这条路上翻车的基本都是中文目录
 *
 * `-Dstdout.encoding` / `-Dstderr.encoding` 是 Java 19 才加的官方属性，
 * 更早的版本认的是 `-Dsun.*` 那两个；两套都给上，多余的会被忽略。
 */
export const UTF8_CONSOLE_FLAGS = [
  '-Dfile.encoding=UTF-8',
  '-Dstdout.encoding=UTF-8',
  '-Dstderr.encoding=UTF-8',
  '-Dsun.stdout.encoding=UTF-8',
  '-Dsun.stderr.encoding=UTF-8'
]
