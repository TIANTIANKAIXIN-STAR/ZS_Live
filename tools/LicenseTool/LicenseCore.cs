using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;

namespace LicenseTool;

/// <summary>
/// ZS Live 授权签发核心（与 server/src/license.js 共用同一套 RSA 非对称规则）。
/// 抽出为独立文件，GUI 工具与兼容性测试共用，避免逻辑漂移。
///
///   token = base64url(payloadJson) + "." + base64url(RSA-SHA256(base64url(payloadJson)))
///   payload = { v, iat, exp?, max, edition, to }   （exp 仅在有效期>0 时存在）
///
/// 私钥只从外部 license.priv.pem 读取，绝不内嵌到任何产物。
/// </summary>
internal static class LicenseCore
{
    public static string B64Url(byte[] b) =>
        Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] B64UrlDecode(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        while (t.Length % 4 != 0) t += '=';
        return Convert.FromBase64String(t);
    }

    // 与 server/src/license.js 的 JSON 字段顺序严格一致：v, iat, exp, max, edition, to
    public static string BuildPayload(long days, long max, string edition, string to)
    {
        var iat = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var exp = days > 0 ? iat + days * 86400000L : 0L;
        var sb = new StringBuilder();
        sb.Append('{');
        sb.Append("\"v\":1");
        sb.Append(",\"iat\":").Append(iat);
        if (days > 0) sb.Append(",\"exp\":").Append(exp);
        sb.Append(",\"max\":").Append(max);
        sb.Append(",\"edition\":\"").Append(edition).Append('"');
        sb.Append(",\"to\":\"").Append(to.Replace("\\", "\\\\").Replace("\"", "\\\"")).Append('"');
        sb.Append('}');
        return sb.ToString();
    }

    public static (bool ok, string token, string err) Sign(string privPem, long days, long max, string edition, string to)
    {
        try
        {
            var payload = BuildPayload(days, max, edition, to);
            var payloadB64 = B64Url(Encoding.UTF8.GetBytes(payload));
            using var rsa = RSA.Create();
            rsa.ImportFromPem(privPem.ToCharArray());
            var sig = rsa.SignData(Encoding.UTF8.GetBytes(payloadB64), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            return (true, payloadB64 + "." + B64Url(sig), "");
        }
        catch (Exception ex) { return (false, "", ex.Message); }
    }

    public static (bool ok, string info, string err) Verify(string pubPem, string token)
    {
        try
        {
            var parts = token.Split('.');
            if (parts.Length != 2) return (false, "", "格式错误：Token 应为 payload.sig 两段");
            var payloadB64 = parts[0];
            var sig = B64UrlDecode(parts[1]);
            using var rsa = RSA.Create();
            rsa.ImportFromPem(pubPem.ToCharArray());
            if (!rsa.VerifyData(Encoding.UTF8.GetBytes(payloadB64), sig, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
                return (false, "", "签名无效（伪造或密钥不匹配）");

            var json = Encoding.UTF8.GetString(B64UrlDecode(payloadB64));
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var iat = root.TryGetProperty("iat", out var vi) ? vi.GetInt64() : 0;
            var exp = root.TryGetProperty("exp", out var ve) ? ve.GetInt64() : 0;
            var max = root.TryGetProperty("max", out var vm) ? vm.GetInt64() : 0;
            var edition = root.TryGetProperty("edition", out var ve2) ? ve2.GetString() : "";
            var to = root.TryGetProperty("to", out var vt) ? vt.GetString() : "";
            var expired = exp > 0 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > exp;
            var info = "OK|edition=" + edition + "|max=" + max + "|to=" + to
                + "|exp=" + (exp > 0 ? exp.ToString() : "permanent") + "|expired=" + (expired ? "1" : "0");
            return (true, info, "");
        }
        catch (Exception ex) { return (false, "", ex.Message); }
    }
}
