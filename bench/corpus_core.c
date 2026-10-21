/* CodeDocBench 解析准确率基准语料 —— 核心集（工具设计口径内应识别的构造）
 *
 * 设计目标：每一段只测一类构造，按行号可直接回溯到源码。
 * 全程合法 C，不引入工具明确声明"不做"的语法（完整预处理 / 完整文法）。
 * 评测口径见 bench/ground_truth.json 与 bench/run_accuracy.py。
 */

/* ============ 1) Includes ============ */
#include <stdio.h>
#include <stdint.h>
#include <sys/stat.h>
#include "config.h"

/* ============ 2) Macros（#define 一律归宏） ============ */
#define BUF_SIZE 1024
#define STR_HELLO "hello"
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define EMPTY_MACRO
#define MULTI_LINE(x) \
    do { (x)++; } while (0)
#define FLAG_ON()

/* ============ 3) Constants（const 限定的全局变量，基类型 const / 指针 const 均算） ============ */
const int MAX_LEVEL = 100;
static const double PI = 3.14159;
const char *GREETING = "hi";
char *const DEVICE = (char*)0;
extern const long CAP;
const int C_A = 1, C_B = 2;

/* ============ 4) Globals（非 const 全局变量） ============ */
int g_counter;
static int g_hidden = 0;
int *g_ptr = NULL;
int g_arr[16];
extern int g_extern;
int g_a, g_b, g_c;
volatile int g_status;
int g_init = compute_init();

/* ============ 5) Structs / Union ============ */
struct Point { int x; int y; };
struct Rect { int w; int h; struct Point origin; };
union U { int i; float f; };
struct Point g_origin;

/* ============ 6) Enums ============ */
enum Color { RED, GREEN, BLUE };
enum State { S_INIT = 0, S_RUN, S_STOP };
enum Color g_color;

/* ============ 7) Typedefs ============ */
typedef unsigned int uint32_t;
typedef int *pint;
typedef struct Node Node_t;
typedef struct { int lo; int hi; } Range, *RangePtr;
typedef enum { R1, R2 } EnumTag;
typedef void (*handler_t)(int);
typedef int IntArray[8];

/* ============ 8) Functions（定义 / 声明 / static / 指针返回 / 函数指针参数 / 变参 / extern） ============ */
int add(int a, int b);
int add(int a, int b) { return a + b; }
static int internal(void) { return 0; }
char* get_name(void);
void log_msg(const char *fmt, ...);
int *alloc(int n);
void on_event(int (*cb)(int));
extern int api_call(int code);
