#define _GNU_SOURCE
#include <stdio.h>
#include <unistd.h>
#ifdef __linux__
#include <fcntl.h>
#include <sys/syscall.h>
#endif

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  puts("ready");
  fflush(stdout);
  for (;;) {
#ifdef __APPLE__
    if (renamex_np(argv[1], argv[2], RENAME_SWAP) != 0) return 1;
#else
    if (syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2], 2) != 0) return 1;
#endif
  }
}
