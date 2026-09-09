#include <stdio.h>
#include "util.h"

int main(int argc, char** argv) {
    int data[] = {1, 2, 3, 4};
    double avg = average(data, 4);
    struct Point p = make_point(3, 5);
    printf("avg=%.2f point=(%d,%d) scale=%d\n", avg, p.x, p.y, scale(2));
    return 0;
}