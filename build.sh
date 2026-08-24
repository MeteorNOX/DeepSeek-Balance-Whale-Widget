#!/bin/bash
# ============================================
# 小鲸鱼余额挂件 - 手工工具链构建脚本 (ARM64 + qemu适配版)
# require: javac17(native), qemu-x86_64, java
# ============================================
set -e
set -o pipefail
ROOT=/tmp/whale-app
APP=$ROOT/app
SRC=$ROOT/src
RES=$APP/src/main/res
MANIFEST=$ROOT/AndroidManifest.xml
ANDROID_JAR=/opt/android-35/android.jar
AAPT2="qemu-x86_64 /opt/android-15/aapt2"
D8="java -cp /opt/android-15/lib/d8.jar com.android.tools.r8.D8"
ZIPALIGN="qemu-x86_64 /opt/android-15/zipalign"
APKSIGNER="java -cp /opt/android-15/lib/apksigner.jar com.android.apksigner.ApkSignerTool"
KS=$ROOT/whale.keystore
KSPASS=${WHALE_KS_PASS:-whale-widget-release}

BUILD=$ROOT/build
rm -rf $BUILD
mkdir -p $BUILD/gen $BUILD/classes

echo "=== [1/8] keystore ==="
if [ ! -f $KS ]; then
  keytool -genkeypair -v -keystore $KS -alias whale -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass $KSPASS -keypass $KSPASS \
    -dname "CN=Whale Widget, OU=Dev, O=Whale, C=CN" 2>&1 | tail -2
fi

echo "=== [2/8] aapt2 compile ==="
$AAPT2 compile --dir $RES -o $BUILD/res.zip

echo "=== [3/8] aapt2 link ==="
$AAPT2 link -o $BUILD/app.unaligned.apk \
  -I $ANDROID_JAR \
  --manifest $MANIFEST \
  --java $BUILD/gen \
  --min-sdk-version 24 --target-sdk-version 35 \
  --version-code 8 --version-name 2.1.0 \
  --auto-add-overlay \
  $BUILD/res.zip

echo "=== [4/8] javac ==="
find $SRC -name "*.java" > $BUILD/sources.txt
echo "$BUILD/gen/com/whale/deepseek/widget/R.java" >> $BUILD/sources.txt
javac -source 8 -target 8 -encoding UTF-8 \
  -classpath $ANDROID_JAR \
  -d $BUILD/classes \
  @$BUILD/sources.txt 2>&1 | tail -8

echo "=== [5/8] d8 (dex) ==="
find $BUILD/classes -name "*.class" > $BUILD/classlist.txt
$D8 --release --min-api 24 --lib $ANDROID_JAR --output $BUILD \
  $(cat $BUILD/classlist.txt | tr '\n' ' ') 2>&1 | tail -3
ls -la $BUILD/classes.dex

echo "=== [6/8] dex into apk ==="
cd $BUILD
cp app.unaligned.apk withdex.apk
python3 - <<'PYEOF'
import zipfile
src = "withdex.apk"
dst = "withdex2.apk"
with zipfile.ZipFile(src) as z:
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as out:
        for info in z.infolist():
            out.writestr(info, z.read(info.filename))  # 保留原始 compress_type（arsc 需要 stored）
        out.write("classes.dex", "classes.dex")
print("dex注入完成")
PYEOF
mv withdex2.apk withdex.apk

echo "=== [7/8] zipalign ==="
$ZIPALIGN -f 4 withdex.apk app-aligned.apk

echo "=== [8/8] apksigner sign ==="
rm -f app-release.apk
$APKSIGNER sign --ks $KS --ks-pass pass:$KSPASS \
  --out $ROOT/build/app-release.apk app-aligned.apk 2>&1 | tail -3
$APKSIGNER verify $ROOT/build/app-release.apk 2>&1 | tail -3

echo ""
echo "======================================"
echo "BUILD SUCCESS: $ROOT/build/app-release.apk"
ls -la $ROOT/build/app-release.apk
echo "======================================"