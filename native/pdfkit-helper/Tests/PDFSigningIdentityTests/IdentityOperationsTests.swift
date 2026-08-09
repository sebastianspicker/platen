import LocalAuthentication
import Security
import XCTest

@testable import PDFSigningIdentity

final class IdentityOperationsTests: XCTestCase {
    func testIdentityQueryDisablesAuthenticationInteraction() throws {
        let query = nonInteractiveIdentityQuery()

        let authenticationContext = try XCTUnwrap(
            query[kSecUseAuthenticationContext] as? LAContext
        )
        XCTAssertTrue(authenticationContext.interactionNotAllowed)
        XCTAssertEqual(query.count, 4)
        XCTAssertEqual(query[kSecReturnRef] as? Bool, true)
    }
}
