package cc.livx.appwrap

import android.content.Context
import android.content.Intent
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * NS-callable bridge over Health Connect (whose client API is Kotlin-`suspend`-only). Wraps each
 * suspend call in a coroutine and delivers the result through a plain callback ON THE MAIN THREAD —
 * so the JS continuation (and the WebView response delivery) runs on the UI thread. Shipped via the
 * app's overrides/ until the framework grows first-class Health Connect support.
 */
object HealthConnectBridge {
    interface LongCallback { fun onResult(value: Long) }
    interface BoolCallback { fun onResult(value: Boolean) }

    private val READ_STEPS = HealthPermission.getReadPermission(StepsRecord::class)

    @JvmStatic
    fun isAvailable(context: Context): Boolean =
        HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE

    /** Intent that launches the Health Connect permission UI (for startActivityForResult). */
    @JvmStatic
    fun permissionIntent(context: Context): Intent =
        PermissionController.createRequestPermissionResultContract().createIntent(context, setOf(READ_STEPS))

    @JvmStatic
    fun hasPermission(context: Context, cb: BoolCallback) {
        val client = HealthConnectClient.getOrCreate(context)
        CoroutineScope(Dispatchers.IO).launch {
            val granted = try {
                client.permissionController.getGrantedPermissions().contains(READ_STEPS)
            } catch (e: Exception) { false }
            withContext(Dispatchers.Main) { cb.onResult(granted) }
        }
    }

    /** Today's total steps. Prefers `aggregate` (dedupes across sources incl. Wear on real devices);
     * falls back to summing raw records when aggregate yields null (a known HC quirk — e.g. the
     * emulator provider / a single app's manual records). Returns -1 when permission isn't granted. */
    private suspend fun todayTotal(client: HealthConnectClient): Long {
        val zone = ZoneId.systemDefault()
        val range = TimeRangeFilter.between(LocalDate.now(zone).atStartOfDay(zone).toInstant(), Instant.now())
        val agg = client.aggregate(AggregateRequest(setOf(StepsRecord.COUNT_TOTAL), range))[StepsRecord.COUNT_TOTAL]
        if (agg != null) return agg
        val read = client.readRecords(androidx.health.connect.client.request.ReadRecordsRequest(StepsRecord::class, range))
        return read.records.sumOf { it.count }
    }

    @JvmStatic
    fun readTodaySteps(context: Context, cb: LongCallback) {
        val client = HealthConnectClient.getOrCreate(context)
        CoroutineScope(Dispatchers.IO).launch {
            val result: Long = try {
                if (!client.permissionController.getGrantedPermissions().contains(READ_STEPS)) -1L
                else todayTotal(client)
            } catch (e: Exception) { -2L }
            withContext(Dispatchers.Main) { cb.onResult(result) }
        }
    }
}
