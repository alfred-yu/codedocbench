#include "data.h"

static int call_count = 0;

double average(const int* arr, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
        sum += arr[i];
    }
    return n > 0 ? (double)sum / n : 0.0;
}

int scale(int v) {
    return v * SQUARE(2);
}

struct Point make_point(int x, int y) {
    struct Point p;
    p.x = x;
    p.y = y;
    return p;
}