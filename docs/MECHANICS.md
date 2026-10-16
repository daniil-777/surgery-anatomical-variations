# Mechanical formulations and evidence

The offline oracle and browser preview implement different declared models. Passing one model's tests does not calibrate the other.

## Offline constitutive oracle

`py/viscera_core/mechanics.py` uses the **polynomial rest-stable Neo-Hookean variant**, equivalent up to a constant to Eq. (13) in [Smith, de Goes and Kim, 2018](https://www.tkim.graphics/NEO/StableNeoHookean2018.pdf). It does not implement the additional logarithmic origin regularizer in their final Eq. (14). In particular, the stronger degeneracy behavior of that final formulation must not be attributed to this implementation.

The actual code evaluates, in SI units,

\[
\psi(F)=\frac{\mu}{2}(F:F-3)+\frac{\lambda_p}{2}\big[(\det F-\alpha)^2-(1-\alpha)^2\big],
\quad \alpha=1+\mu/\lambda_p.
\]

Here `mu = E/(2(1+nu))` and `lambda_p = lambda_Lame + mu`. Differentiating this particular polynomial gives `P = mu F + lambda_p (J-alpha) cof(F)`. Its tangent at identity is `mu(H+Hᵀ) + lambda_Lame tr(H) I`, so the stated engineering constants describe the small-strain tangent. The code subtracts the rest constant without changing stress.

Independent finite differences check energy-to-stress and stress-to-tangent consistency. Rotation, rest, units, simple deformation fixtures and block compression are tested. The nine block trials are synthetic numerical verification; they are not organ indentation, material identification, a contact experiment, or a measured relaxation response. Constitutive constants in these trials are design values, not human tissue measurements.

## Browser interaction preview

`packages/sim` converts geometry from mm to m once and uses lumped mass, compliant edge-length and tetrahedral-volume constraints, explicit support nodes and pairwise velocity damping. The mapping sends each render point through its coarse tetrahedron's affine deformation, including its reference residual. The displacement protocol moves a neighborhood of nodes and releases it; it is not sphere contact.

Each step checks finite state and positive-cell deformation. Invalid steps roll back. A recorded preview reports maximum volume drift, minimum Jacobian, peak displacement and the remaining displacement after release. The final geometry remains visible until Reset. Supports, constitutive approximation and coarse mesh resolution materially affect this behavior; calibration and convergence of a real organ remain unperformed.
