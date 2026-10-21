/* CodeDocBench 解析准确率基准语料 —— 边界集（探测轻量分词解析器的覆盖边界）
 *
 * 这些构造工具 README 明确声明"不做完整 C 文法解析 / 不做完整预处理"，
 * 归类为"已知覆盖缺口"，单独报告，不计入核心准确率分母，避免扭曲结论。
 * 但若工具实际能识别，则视为加分项。
 */

/* 函数返回函数指针（信号/回调注册式签名） */
void (*signal(int sig, void (*h)(int)))(int);

/* K&R 老式函数定义（参数声明在括号外） */
int legacy(a, b) int a; int b; { return a + b; }

/* __attribute__ 修饰（GCC/Clang 扩展） */
__attribute__((noreturn)) void fatal(const char *msg);

/* typedef：函数指针数组 */
typedef int (*ops[4])(void);

/* 嵌套结构体 */
struct Outer { struct Inner { int x; } in; int y; };

/* 位域成员 */
struct Flags { unsigned int a : 1; unsigned int b : 3; };

/* 含函数指针成员的结构体 */
struct Cb { void (*fn)(int); int id; };

/* extern "C" 块（C++ 语法；工具声称支持 .cpp） */
extern "C" { int cpp_func(void); }

/* static inline + restrict 限定 */
static inline int fast(size_t n, int * restrict p);

/* 匿名 union 实例（无 tag） */
union { int anon_i; double anon_d; } g_anon;

/* 匿名 enum 实例（无 tag） */
enum { AE_A, AE_B } g_aenum;
