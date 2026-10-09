#define FUSE_USE_VERSION 31
#define _GNU_SOURCE
#include <fuse3/fuse.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>
#include <dirent.h>

static char backing[4096];
static char fail_match[256];
static const char *realpath_for(const char *p) {
  static __thread char out[8192];
  snprintf(out, sizeof(out), "%s%s", backing, p);
  return out;
}
static int eio_match(const char *p) { return fail_match[0] && strstr(p, fail_match) != NULL; }
static int op_getattr(const char *p, struct stat *st, struct fuse_file_info *fi) { (void)fi; return lstat(realpath_for(p), st) ? -errno : 0; }
static int op_access(const char *p, int mask) { return access(realpath_for(p), mask) ? -errno : 0; }
static int op_readlink(const char *p, char *buf, size_t n) { int r=readlink(realpath_for(p),buf,n-1); if(r<0)return -errno;buf[r]=0;return 0; }
static int op_readdir(const char *p, void *buf, fuse_fill_dir_t fill, off_t off, struct fuse_file_info *fi, enum fuse_readdir_flags flags) {
  (void)off;(void)fi;(void)flags;DIR *d=opendir(realpath_for(p));if(!d)return -errno;struct dirent *e;while((e=readdir(d)))if(fill(buf,e->d_name,NULL,0,0))break;closedir(d);return 0;
}
static int op_mkdir(const char *p, mode_t m) { return mkdir(realpath_for(p),m) ? -errno : 0; }
static int op_unlink(const char *p) { return unlink(realpath_for(p)) ? -errno : 0; }
static int op_rmdir(const char *p) { return rmdir(realpath_for(p)) ? -errno : 0; }
static int op_symlink(const char *t, const char *p) { return symlink(t,realpath_for(p)) ? -errno : 0; }
static int op_rename(const char *a, const char *b, unsigned int flags) { if(flags) return -EINVAL;char from[8192],to[8192];snprintf(from,sizeof(from),"%s%s",backing,a);snprintf(to,sizeof(to),"%s%s",backing,b);return rename(from,to) ? -errno : 0; }
static int op_link(const char *a,const char *b) { char from[8192],to[8192];snprintf(from,sizeof(from),"%s%s",backing,a);snprintf(to,sizeof(to),"%s%s",backing,b);return link(from,to) ? -errno : 0; }
static int op_chmod(const char *p,mode_t m,struct fuse_file_info *fi) { (void)fi;return chmod(realpath_for(p),m) ? -errno : 0; }
static int op_chown(const char *p,uid_t u,gid_t g,struct fuse_file_info *fi) { (void)fi;return lchown(realpath_for(p),u,g) ? -errno : 0; }
static int op_truncate(const char *p,off_t n,struct fuse_file_info *fi) { if(fi&&fi->fh)return ftruncate((int)fi->fh,n)?-errno:0;return truncate(realpath_for(p),n)?-errno:0; }
static int op_open(const char *p,struct fuse_file_info *fi) { int fd=open(realpath_for(p),fi->flags);if(fd<0)return -errno;fi->fh=fd;return 0; }
static int op_create(const char *p,mode_t m,struct fuse_file_info *fi) { int fd=open(realpath_for(p),fi->flags|O_CREAT,m);if(fd<0)return -errno;fi->fh=fd;return 0; }
static int op_read(const char *p,char *b,size_t n,off_t o,struct fuse_file_info *fi) { (void)p;ssize_t r=pread((int)fi->fh,b,n,o);return r<0?-errno:(int)r; }
static int op_write(const char *p,const char *b,size_t n,off_t o,struct fuse_file_info *fi) { (void)p;ssize_t r=pwrite((int)fi->fh,b,n,o);return r<0?-errno:(int)r; }
static int op_flush(const char *p,struct fuse_file_info *fi) { (void)p;return fsync((int)fi->fh)?-errno:0; }
static int op_fsync(const char *p,int datasync,struct fuse_file_info *fi) {
  (void)datasync;
  if(eio_match(p)){fprintf(stderr,"INJECT_KERNEL_FSYNC_EIO %s\n",p);fflush(stderr);return -EIO;}
  int fd=(fi&&fi->fh)?(int)fi->fh:open(realpath_for(p),O_RDONLY|O_DIRECTORY);
  if(fd<0)return -errno;
  int r=fsync(fd),e=errno;
  if(!(fi&&fi->fh))close(fd);
  return r?-e:0;
}
static int op_release(const char *p,struct fuse_file_info *fi) { (void)p;return close((int)fi->fh)?-errno:0; }
static int op_utimens(const char *p,const struct timespec tv[2],struct fuse_file_info *fi) { (void)fi;return utimensat(AT_FDCWD,realpath_for(p),tv,AT_SYMLINK_NOFOLLOW)?-errno:0; }
static int op_statfs(const char *p,struct statvfs *s) { return statvfs(realpath_for(p),s)?-errno:0; }

static struct fuse_operations ops = {
 .getattr=op_getattr,.access=op_access,.readlink=op_readlink,.readdir=op_readdir,
 .mkdir=op_mkdir,.unlink=op_unlink,.rmdir=op_rmdir,.symlink=op_symlink,.rename=op_rename,.link=op_link,
 .chmod=op_chmod,.chown=op_chown,.truncate=op_truncate,.open=op_open,.create=op_create,
 .read=op_read,.write=op_write,.flush=op_flush,.fsync=op_fsync,.release=op_release,.utimens=op_utimens,.statfs=op_statfs
};
int main(int argc,char **argv) {
  if(argc<3){fprintf(stderr,"usage: %s BACKING MOUNTPOINT [fuse options]\n",argv[0]);return 2;}
  if(!realpath(argv[1],backing)){perror("backing");return 2;}
  const char *m=getenv("FUSE_EIO_MATCH");if(m)snprintf(fail_match,sizeof(fail_match),"%s",m);
  argv[1]=argv[2];for(int i=2;i<argc-1;i++)argv[i]=argv[i+1];argc--;
  return fuse_main(argc,argv,&ops,NULL);
}
