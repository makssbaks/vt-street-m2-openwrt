#define _POSIX_C_SOURCE 200809L
#include <sqlite3.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#ifndef VT_TRAFFIC_DIR
#define VT_TRAFFIC_DIR "/etc/vtmodem"
#endif
#define LIVE VT_TRAFFIC_DIR "/traffic/vnstat.db"
#define SNAPSHOT VT_TRAFFIC_DIR "/traffic-backup.db"
#define STAMP VT_TRAFFIC_DIR "/traffic-backup.time"

static long long monotonic_ms(void)
{
	struct timespec now;
	if (clock_gettime(CLOCK_MONOTONIC, &now)) return -1;
	return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int sync_file(const char *path)
{
	int fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0) return -1;
	int rc = fsync(fd);
	close(fd);
	return rc;
}

/* Read the source using SQLite's online-backup API: the result is one coherent
 * database even when vnstatd commits concurrently. All waits share a deadline.
 * Restore never overwrites a running/live database, including on a race. */
static int snapshot(const char *source, const char *destination, int restore)
{
	sqlite3 *src = NULL, *dst = NULL;
	sqlite3_backup *job = NULL;
	char temp[512];
	int rc = -1, step = SQLITE_ERROR;
	long long started = monotonic_ms();
	if (started < 0) return -1;
	if (snprintf(temp, sizeof(temp), "%s.new.%ld", destination, (long)getpid()) >= (int)sizeof(temp)) return -1;
	int fd = open(temp, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
	if (fd < 0) return -1;
	close(fd);
	if (sqlite3_open_v2(source, &src, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) goto done;
	if (sqlite3_open_v2(temp, &dst, SQLITE_OPEN_READWRITE, NULL) != SQLITE_OK) goto done;
	sqlite3_busy_timeout(src, 100);
	sqlite3_busy_timeout(dst, 100);
	job = sqlite3_backup_init(dst, "main", src, "main");
	if (!job) goto done;
	do {
		step = sqlite3_backup_step(job, 64);
		if (step == SQLITE_DONE) break;
		if (step != SQLITE_OK && step != SQLITE_BUSY && step != SQLITE_LOCKED) break;
		struct timespec pause = { .tv_sec = 0, .tv_nsec = 50000000 };
		nanosleep(&pause, NULL);
	} while (monotonic_ms() >= started && monotonic_ms() - started < 5000);
	int finished = sqlite3_backup_finish(job);
	job = NULL;
	if (step != SQLITE_DONE || finished != SQLITE_OK) goto done;
	if (sqlite3_close(dst) != SQLITE_OK) goto done;
	dst = NULL;
	if (sync_file(temp)) goto done;
	if (restore) {
		if (link(temp, destination) && errno != EEXIST) goto done;
		unlink(temp);
	}
	else if (rename(temp, destination)) goto done;
	if (sync_file(restore ? VT_TRAFFIC_DIR "/traffic" : VT_TRAFFIC_DIR)) goto done;
	rc = 0;
done:
	if (job) sqlite3_backup_finish(job);
	if (dst) sqlite3_close(dst);
	if (src) sqlite3_close(src);
	unlink(temp);
	if (rc) fprintf(stderr, "VT traffic: coherent database %s failed\n", restore ? "restore" : "snapshot");
	return rc;
}

static int write_stamp(void)
{
	char temp[512];
	if (snprintf(temp, sizeof(temp), "%s.new.%ld", STAMP, (long)getpid()) >= (int)sizeof(temp)) return -1;
	int fd = open(temp, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
	if (fd < 0) return -1;
	char value[64];
	int length = snprintf(value, sizeof(value), "%lld\n", (long long)time(NULL));
	int ok = write(fd, value, length) == length && fsync(fd) == 0;
	if (close(fd)) ok = 0;
	if (ok && rename(temp, STAMP) == 0 && sync_file(VT_TRAFFIC_DIR) == 0) return 0;
	unlink(temp);
	return -1;
}

int main(int argc, char **argv)
{
	struct stat st;
	umask(077);
	if (argc != 2 || (strcmp(argv[1], "backup") && strcmp(argv[1], "restore"))) return 2;
	int restore = !strcmp(argv[1], "restore");
	if (restore && stat(LIVE, &st) == 0) return 0;
	const char *source = restore ? SNAPSHOT : LIVE;
	if (stat(source, &st)) return errno == ENOENT ? 0 : 1;
	if (!S_ISREG(st.st_mode)) return 1;
	if (snapshot(source, restore ? LIVE : SNAPSHOT, restore)) return 1;
	return !restore && write_stamp() ? 1 : 0;
}
