import Foundation

func strictAecMeasurementRequest(from data: Data) throws -> AecMeasurementRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, ["version", "operation", "inputFilename", "outputFilename", "sourceSha256", "limits", "measurement"]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, ["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"]),
          let measurement = object["measurement"] as? [String: Any],
          exactKeys(measurement, ["id", "page", "kind", "points", "quantity", "unit", "calibrationId", "label", "calibration"]),
          let points = measurement["points"] as? [[String: Any]],
          points.allSatisfy(exactMeasurementPoint),
          exactNullableObject(measurement["calibration"], keys: ["points", "realLength", "sourceUnit", "metersPerPoint"])
    else { throw InspectionFailure.invalidRequest }

    if let calibration = measurement["calibration"] as? [String: Any] {
        guard let calibrationPoints = calibration["points"] as? [[String: Any]], calibrationPoints.allSatisfy(exactMeasurementPoint) else {
            throw InspectionFailure.invalidRequest
        }
    }

    let decoder = JSONDecoder()
    let request: AecMeasurementRequest
    do { request = try decoder.decode(AecMeasurementRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }

    guard request.version == protocolVersion,
          request.operation == "applyAecMeasurement",
          request.inputFilename == mutationInputFilename,
          request.outputFilename == mutationOutputFilename,
          isLowercaseSHA256(request.sourceSha256),
          isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 0, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 0, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 0, maximumOutlineItems),
          aecMeasurementIsBounded(request.measurement)
    else { throw InspectionFailure.invalidRequest }
    return request
}

func validAecIdentifier(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    return isWithin(bytes.count, 1, 64) && bytes.allSatisfy { byte in
        (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
            || byte == 45 || byte == 46 || byte == 95
    }
}

func validAecLabel(_ value: String) -> Bool {
    value.utf8.count <= 160 && !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
}

func validMeasurementPoint(_ point: MeasurementPoint) -> Bool {
    point.x.isFinite && point.y.isFinite && abs(point.x) <= maximumCoordinate && abs(point.y) <= maximumCoordinate
}

func aecMeasurementIsBounded(_ measurement: AecMeasurement) -> Bool {
    guard validAecIdentifier(measurement.id), validMutationPage(measurement.page),
          ["distance", "perimeter", "area", "count"].contains(measurement.kind),
          isWithin(measurement.points.count, 1, maximumAnnotationsPerPage),
          measurement.points.allSatisfy(validMeasurementPoint),
          measurement.quantity.isFinite, measurement.quantity > 0,
          validAecLabel(measurement.label)
    else { return false }
    if measurement.kind == "count" {
        return measurement.unit == "count" && measurement.calibrationId == nil && measurement.calibration == nil
    }
    guard let calibrationId = measurement.calibrationId, let calibration = measurement.calibration,
          validAecIdentifier(calibrationId), calibration.points.count == 2,
          calibration.points.allSatisfy(validMeasurementPoint), calibration.realLength.isFinite, calibration.realLength > 0,
          calibration.metersPerPoint.isFinite, calibration.metersPerPoint > 0,
          ["mm", "cm", "m", "in", "ft"].contains(calibration.sourceUnit)
    else { return false }
    switch measurement.kind {
    case "distance", "perimeter": return measurement.unit == "m" && measurement.points.count >= (measurement.kind == "distance" ? 2 : 3)
    case "area": return measurement.unit == "m2" && measurement.points.count >= 3
    default: return false
    }
}
