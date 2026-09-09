#ifndef DATA_H
#define DATA_H

#define MAX_LEN 100
#define SQUARE(x) ((x) * (x))
#define VERSION "1.0.0"

typedef unsigned int u32;
typedef struct Point Point;

typedef struct {
    int x;
    int y;
} Coord;

enum Color { RED, GREEN, BLUE };

struct Point {
    int x;
    int y;
    char* label;
};

#endif /* DATA_H */